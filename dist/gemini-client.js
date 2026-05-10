/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { GeminiChat } from '@google/gemini-cli-core';
import { FunctionCallingConfigMode, } from '@google/genai';
import { logger } from './utils/logger.js';
function base64urlEncode(s) {
    return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(s) {
    let b = s.replace(/-/g, '+').replace(/_/g, '/');
    const r = b.length % 4;
    if (r === 2)
        b += '==';
    else if (r === 3)
        b += '=';
    return b;
}
function extractThoughtSigFromId(toolCallId) {
    // Format: call.{name}.{b64sig}.{uuid}
    const parts = toolCallId.split('.');
    if (parts.length >= 4 && parts[0] === 'call') {
        const encoded = parts[2];
        if (encoded.length >= 5)
            return base64urlDecode(encoded);
    }
    return null;
}
function mergeFunctionResponseUserEntries(contents) {
    const merged = [];
    const isFuncResp = (c) => c.role === 'user' && c.parts?.length && c.parts.every(p => p.functionResponse);
    let pending = null;
    for (const content of contents) {
        if (isFuncResp(content)) {
            if (pending) {
                pending.parts.push(...content.parts);
            }
            else {
                pending = { role: 'user', parts: [...content.parts] };
            }
        }
        else {
            if (pending) {
                merged.push(pending);
                pending = null;
            }
            merged.push(content);
        }
    }
    if (pending)
        merged.push(pending);
    return merged;
}
const UNSUPPORTED_KEYS = new Set([
    '$schema', '$ref', 'ref', '$defs', 'definitions',
    'additionalProperties', 'patternProperties',
    'exclusiveMinimum', 'exclusiveMaximum',
    'oneOf', 'anyOf', 'allOf', 'not',
    'if', 'then', 'else',
    'dependentSchemas', 'dependentRequired',
    'unevaluatedProperties', 'unevaluatedItems',
    'contentEncoding', 'contentMediaType',
]);
function resolveRef(schema, root) {
    if (typeof schema !== 'object' || schema === null)
        return schema;
    const refValue = schema.$ref || schema.ref;
    if (refValue) {
        const defs = root.$defs || root.definitions || {};
        if (typeof refValue === 'string') {
            let defName = null;
            if (refValue.startsWith('#/$defs/')) {
                defName = refValue.slice('#/$defs/'.length);
            }
            else if (refValue.startsWith('#/definitions/')) {
                defName = refValue.slice('#/definitions/'.length);
            }
            else if (defs[refValue]) {
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
    if (typeof schema !== 'object' || schema === null)
        return schema;
    const resolved = resolveRef(schema, schema);
    const newSchema = {};
    for (const key in resolved) {
        if (!UNSUPPORTED_KEYS.has(key)) {
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
    convertOpenAIToolsToGemini(openAITools) {
        if (!openAITools || openAITools.length === 0)
            return undefined;
        const functionDeclarations = openAITools
            .filter(tool => tool.type === 'function' && tool.function)
            .map(tool => ({
            name: tool.function.name,
            description: tool.function.description,
            parameters: sanitizeGeminiSchema(tool.function.parameters),
        }));
        if (functionDeclarations.length === 0)
            return undefined;
        return [{ functionDeclarations }];
    }
    parseFunctionNameFromId(toolCallId) {
        const parts = toolCallId.split('.');
        if (parts.length >= 2 && parts[0] === 'call') {
            return parts[1];
        }
        return 'unknown_tool_from_id';
    }
    openAIMessageToGemini(msg) {
        if (msg.role === 'assistant') {
            const parts = [];
            if (msg.content && typeof msg.content === 'string') {
                parts.push({ text: msg.content });
            }
            if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
                for (const toolCall of msg.tool_calls) {
                    if (toolCall.type === 'function' && toolCall.function) {
                        try {
                            const argsObject = JSON.parse(toolCall.function.arguments);
                            const fnName = toolCall.function.name;
                            const sig = extractThoughtSigFromId(toolCall.id || '');
                            if (sig) {
                                parts.push({ thought: true, thoughtSignature: sig });
                            }
                            parts.push({
                                functionCall: { name: fnName, args: argsObject },
                            });
                        }
                        catch (e) {
                            logger.warn('Failed to parse tool call arguments', { arguments: toolCall.function.arguments }, e);
                        }
                    }
                }
            }
            return { role: 'model', parts };
        }
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
                role: 'user',
                parts: [{ functionResponse: { name: functionName, response: responsePayload } }],
            };
        }
        const role = 'user';
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
    async sendMessageStream({ model, messages, tools, tool_choice, }) {
        let clientSystemInstruction = undefined;
        const useInternalPrompt = !!this.config.getUserMemory();
        if (!useInternalPrompt) {
            const systemMessageIndex = messages.findIndex(msg => msg.role === 'system');
            if (systemMessageIndex !== -1) {
                const systemMessage = messages.splice(systemMessageIndex, 1)[0];
                clientSystemInstruction = this.openAIMessageToGemini(systemMessage);
            }
        }
        const history = mergeFunctionResponseUserEntries(messages.map(msg => this.openAIMessageToGemini(msg)));
        const lastMessage = history.pop();
        logger.info('Calling Gemini API', { model });
        logger.debug(this.debugMode, 'Sending request to Gemini', { historyLength: history.length, lastMessage });
        if (!lastMessage)
            throw new Error('No message to send.');
        if (model && typeof model === 'string') {
            try {
                this.config.setModel(model);
            }
            catch (e) {
                logger.warn('Failed to set model:', e);
            }
        }
        const oneShotChat = new GeminiChat(this.config, this.contentGenerator, {}, history);
        const geminiTools = this.convertOpenAIToolsToGemini(tools);
        const generationConfig = {};
        if (clientSystemInstruction) {
            generationConfig.systemInstruction = clientSystemInstruction;
        }
        if (tool_choice && tool_choice !== 'auto') {
            generationConfig.toolConfig = {
                functionCallingConfig: {
                    mode: tool_choice.type === 'function' ? FunctionCallingConfigMode.ANY : FunctionCallingConfigMode.AUTO,
                    allowedFunctionNames: tool_choice.function ? [tool_choice.function.name] : undefined,
                },
            };
        }
        const prompt_id = Math.random().toString(16).slice(2);
        const geminiStream = await oneShotChat.sendMessageStream({
            message: lastMessage.parts || [],
            config: { tools: geminiTools, ...generationConfig },
        }, prompt_id);
        logger.debug(this.debugMode, 'Got stream from Gemini.');
        return (async function* () {
            let pendingThoughtSig = null;
            for await (const response of geminiStream) {
                const parts = response.candidates?.[0]?.content?.parts || [];
                for (const part of parts) {
                    const partAny = part;
                    const sig = partAny.thoughtSignature || null;
                    if (sig)
                        pendingThoughtSig = sig;
                    if (part.text) {
                        yield { type: 'text', data: part.text };
                    }
                    if (part.functionCall && part.functionCall.name) {
                        const fnName = part.functionCall.name;
                        const toolSig = pendingThoughtSig ? base64urlEncode(pendingThoughtSig) : undefined;
                        yield {
                            type: 'tool_code',
                            data: {
                                name: fnName,
                                args: part.functionCall.args ?? {},
                                thoughtSignature: toolSig,
                            },
                        };
                    }
                }
            }
        })();
    }
}
