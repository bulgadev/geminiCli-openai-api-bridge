/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { GeminiChat } from '@google/gemini-cli-core';
import { FunctionCallingConfigMode, } from '@google/genai';
import { logger } from './utils/logger.js';

const unsupportedKeys = [
    '$schema',
    '$ref',
    'ref',
    '$defs',
    'definitions',
    'additionalProperties',
    'patternProperties',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'oneOf',
    'anyOf',
    'allOf',
    'not',
    'if',
    'then',
    'else',
    'dependentSchemas',
    'dependentRequired',
    'unevaluatedProperties',
    'unevaluatedItems',
    'contentEncoding',
    'contentMediaType',
];

function resolveRef(schema, root) {
    if (typeof schema !== 'object' || schema === null) return schema;
    const refValue = schema.$ref || schema.ref;
    if (refValue) {
        const defs = root.$defs || root.definitions || {};
        if (typeof refValue === 'string') {
            let defName = null;
            if (refValue.startsWith('#/$defs/')) {
                defName = refValue.slice('#/$defs/'.length);
            } else if (refValue.startsWith('#/definitions/')) {
                defName = refValue.slice('#/definitions/'.length);
            } else if (defs[refValue]) {
                defName = refValue;
            }
            if (defName && defs[defName]) {
                const resolved = { ...defs[defName] };
                for (const k of Object.keys(schema)) {
                    if (k !== '$ref' && k !== 'ref') {
                        resolved[k] = schema[k];
                    }
                }
                return resolveRef(resolved, root);
            }
        }
    }
    if (Array.isArray(schema)) {
        return schema.map(item => resolveRef(item, root));
    }
    if (typeof schema === 'object') {
        const result = {};
        for (const key of Object.keys(schema)) {
            result[key] = resolveRef(schema[key], root);
        }
        return result;
    }
    return schema;
}

function sanitizeGeminiSchema(schema) {
    if (typeof schema !== 'object' || schema === null) {
        return schema;
    }

    const resolved = resolveRef(schema, schema);

    const newSchema = {};
    for (const key in resolved) {
        if (!unsupportedKeys.includes(key)) {
            newSchema[key] = resolved[key];
        }
    }

    if (resolved.exclusiveMinimum !== undefined && newSchema.minimum === undefined) {
        newSchema.minimum = resolved.exclusiveMinimum;
    }
    if (resolved.exclusiveMaximum !== undefined && newSchema.maximum === undefined) {
        newSchema.maximum = resolved.exclusiveMaximum;
    }

    if (newSchema.properties) {
        const newProperties = {};
        for (const key in newSchema.properties) {
            newProperties[key] = sanitizeGeminiSchema(newSchema.properties[key]);
        }
        newSchema.properties = newProperties;
    }

    if (newSchema.items) {
        newSchema.items = sanitizeGeminiSchema(newSchema.items);
    }

    if (newSchema.type === 'object' && newSchema.properties) {
        for (const val of Object.values(newSchema.properties)) {
            if (typeof val === 'object' && val !== null) {
                sanitizeGeminiSchema(val);
            }
        }
    }

    return newSchema;
}

export class GeminiApiClient {
    config;
    contentGenerator;
    debugMode;

    constructor(config, debugMode = false) {
        this.config = config;
        this.contentGenerator = this.config.getGeminiClient().getContentGenerator();
        this.debugMode = debugMode;
    }

    /**
     * Parses the original function name from a tool_call_id.
     * ID format: "call_{functionName}_{uuid}"
     */
    parseFunctionNameFromId(toolCallId) {
        const parts = toolCallId.split('_');
        if (parts.length > 2 && parts[0] === 'call') {
            // Reassemble the function name which might contain underscores.
            return parts.slice(1, parts.length - 1).join('_');
        }
        // Fallback mechanism, not ideal but better than sending a wrong name.
        return 'unknown_tool_from_id';
    }

    /**
     * Converts OpenAI tool definitions to Gemini tool definitions.
     */
    convertOpenAIToolsToGemini(openAITools) {
        if (!openAITools || openAITools.length === 0) {
            return undefined;
        }

        const functionDeclarations = openAITools
            .filter(tool => tool.type === 'function' && tool.function)
            .map(tool => {
            const sanitizedParameters = sanitizeGeminiSchema(tool.function.parameters);
            const serialized = JSON.stringify(sanitizedParameters) || '';
            if (serialized.includes('$ref') || serialized.includes('$defs') || serialized.includes('"definitions"') || serialized.includes('"ref"')) {
                console.error('[BRIDGE-BUG] ref/$ref/$defs/definitions survived sanitization for tool:', tool.function.name);
                console.error('[BRIDGE-BUG] Raw parameters:', JSON.stringify(tool.function.parameters));
                console.error('[BRIDGE-BUG] Sanitized parameters:', serialized);
            }
            return {
                name: tool.function.name,
                description: tool.function.description,
                parameters: sanitizedParameters,
            };
        });

        if (functionDeclarations.length === 0) {
            return undefined;
        }

        return [{ functionDeclarations }];
    }

    /**
     * Converts an OpenAI-formatted message to a Gemini-formatted Content object.
     */
    openAIMessageToGemini(msg) {
        // Handle assistant messages, which can contain both text and tool calls
        if (msg.role === 'assistant') {
            const parts = [];
            // Handle text content. It can be null when tool_calls are present.
            if (msg.content && typeof msg.content === 'string') {
                parts.push({ text: msg.content });
            }

            // Handle tool calls
            if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
                for (const toolCall of msg.tool_calls) {
                    if (toolCall.type === 'function' && toolCall.function) {
                        try {
                            // Gemini API's functionCall.args expects an object, not a string.
                            // OpenAI's arguments is a JSON string, so it needs to be parsed.
                            const argsObject = JSON.parse(toolCall.function.arguments);
                            parts.push({
                                functionCall: {
                                    name: toolCall.function.name,
                                    args: argsObject,
                                },
                            });
                        }
                        catch (e) {
                            logger.warn('Failed to parse tool call arguments',
                                { arguments: toolCall.function.arguments }, e);
                        }
                    }
                }
            }

            return { role: 'model', parts };
        }

        // Handle tool responses
        if (msg.role === 'tool') {
            const functionName = this.parseFunctionNameFromId(msg.tool_call_id || '');
            let responsePayload;

            try {
                const parsed = JSON.parse(msg.content);
                if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                    responsePayload = parsed;
                }
                else {
                    responsePayload = { output: parsed };
                }
            }
            catch (e) {
                responsePayload = { output: msg.content };
            }

            return {
                role: 'user', // A tool response must be in a 'user' role message for Gemini API history.
                parts: [
                    {
                        functionResponse: {
                            name: functionName,
                            response: responsePayload,
                        },
                    },
                ],
            };
        }

        // Handle user and system messages
        const role = 'user'; // system and user roles are mapped to 'user'

        if (typeof msg.content === 'string') {
            return { role, parts: [{ text: msg.content }] };
        }

        if (Array.isArray(msg.content)) {
            const parts = msg.content.reduce((acc, part) => {
                if (part.type === 'text') {
                    acc.push({ text: part.text || '' });
                }
                else if (part.type === 'image_url' && part.image_url) {
                    const imageUrl = part.image_url.url;
                    if (imageUrl.startsWith('data:')) {
                        const [mimePart, dataPart] = imageUrl.split(',');
                        const mimeType = mimePart.split(':')[1].split(';')[0];
                        acc.push({ inlineData: { mimeType, data: dataPart } });
                    }
                    else {
                        acc.push({ fileData: { mimeType: 'image/jpeg', fileUri: imageUrl } });
                    }
                }
                return acc;
            }, []);

            return { role, parts };
        }

        return { role, parts: [{ text: '' }] };
    }

    /**
     * Converts OpenAI messages to Gemini format, merging consecutive tool responses.
     * Gemini requires all tool responses for a turn to be in a single Content object.
     */
    convertMessagesToGemini(messages) {
        const result = [];
        let i = 0;

        while (i < messages.length) {
            const msg = messages[i];

            // If this is a tool response, collect all consecutive tool responses
            if (msg.role === 'tool') {
                const toolResponseParts = [];

                // Collect all consecutive tool messages into one Content
                while (i < messages.length && messages[i].role === 'tool') {
                    const toolMsg = messages[i];
                    const functionName = this.parseFunctionNameFromId(toolMsg.tool_call_id || '');
                    let responsePayload;

                    try {
                        const parsed = JSON.parse(toolMsg.content);
                        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                            responsePayload = parsed;
                        }
                        else {
                            responsePayload = { output: parsed };
                        }
                    }
                    catch (e) {
                        responsePayload = { output: toolMsg.content };
                    }

                    toolResponseParts.push({
                        functionResponse: {
                            name: functionName,
                            response: responsePayload,
                        },
                    });
                    i++;
                }

                // Add single Content with all tool responses merged
                result.push({ role: 'user', parts: toolResponseParts });
            }
            else {
                // Non-tool message, convert normally
                result.push(this.openAIMessageToGemini(msg));
                i++;
            }
        }

        return result;
    }

    /**
     * Sends a streaming request to the Gemini API.
     */
    async sendMessageStream({ model, messages, tools, tool_choice, }) {
        let clientSystemInstruction = undefined;
        const useInternalPrompt = !!this.config.getUserMemory(); // Check if there is a prompt from GEMINI.md

        // If not using the internal prompt, treat the client's system prompt as the system instruction.
        if (!useInternalPrompt) {
            const systemMessageIndex = messages.findIndex(msg => msg.role === 'system');
            if (systemMessageIndex !== -1) {
                // Splice returns an array of removed items, so we take the first one.
                const systemMessage = messages.splice(systemMessageIndex, 1)[0];
                clientSystemInstruction = this.openAIMessageToGemini(systemMessage);
            }
        }

        // Use convertMessagesToGemini to properly merge consecutive tool responses
        const history = this.convertMessagesToGemini(messages);
        const lastMessage = history.pop();

        logger.info('Calling Gemini API', { model });

        logger.debug(this.debugMode, 'Sending request to Gemini', {
            historyLength: history.length,
            lastMessage,
        });

        if (!lastMessage) {
            throw new Error('No message to send.');
        }

        // Set the requested model before creating the chat session
        if (model && typeof model === 'string') {
            try { this.config.setModel(model); } catch (e) { logger.warn('Failed to set model:', e); }
        }

        // Create a new, isolated chat session for each request.
        const oneShotChat = new GeminiChat(this.config, this.contentGenerator, {}, history);

        const geminiTools = this.convertOpenAIToolsToGemini(tools);

        const generationConfig = {};
        // If a system prompt was extracted from the client's request, use it. This
        // will override any system prompt set in the GeminiChat instance.
        if (clientSystemInstruction) {
            generationConfig.systemInstruction = clientSystemInstruction;
        }

        if (tool_choice && tool_choice !== 'auto') {
            generationConfig.toolConfig = {
                functionCallingConfig: {
                    mode: tool_choice.type === 'function'
                        ? FunctionCallingConfigMode.ANY
                        : FunctionCallingConfigMode.AUTO,
                    allowedFunctionNames: tool_choice.function
                        ? [tool_choice.function.name]
                        : undefined,
                },
            };
        }

        const prompt_id = Math.random().toString(16).slice(2);
        const geminiStream = await oneShotChat.sendMessageStream({
            message: lastMessage.parts || [],
            config: {
                tools: geminiTools,
                ...generationConfig,
            },
        }, prompt_id);

        logger.debug(this.debugMode, 'Got stream from Gemini.');

        // Transform the event stream to a simpler StreamChunk stream
        return (async function* () {
            for await (const response of geminiStream) {
                const parts = response.candidates?.[0]?.content?.parts || [];
                for (const part of parts) {
                    if (part.text) {
                        yield { type: 'text', data: part.text };
                    }
                    if (part.functionCall && part.functionCall.name) {
                        yield {
                            type: 'tool_code',
                            data: {
                                name: part.functionCall.name,
                                args: part.functionCall.args ?? {},
                            },
                        };
                    }
                }
            }
        })();
    }
}
//# sourceMappingURL=gemini-client.js.map
