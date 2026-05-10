/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Config, GeminiChat } from '@google/gemini-cli-core';
import {
  type Content,
  type Part,
  type Tool,
  type FunctionDeclaration,
  type GenerateContentConfig,
  FunctionCallingConfigMode,
} from '@google/genai';
import {
  type OpenAIMessage,
  type MessageContentPart,
  type OpenAIChatCompletionRequest,
  type StreamChunk,
  type ReasoningData,
} from './types.js';
import { logger } from './utils/logger.js';

export function base64urlEncode(s: string): string {
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(s: string): string {
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  const r = b.length % 4;
  if (r === 2) b += '==';
  else if (r === 3) b += '=';
  return b;
}

export function extractThoughtSigFromId(toolCallId: string): string | null {
  // Format: call.{name}.{b64sig}.{uuid}
  const parts = toolCallId.split('.');
  if (parts.length >= 4 && parts[0] === 'call') {
    const encoded = parts[2];
    if (encoded.length >= 5) return base64urlDecode(encoded);
  }
  return null;
}

export function mergeFunctionResponseUserEntries(contents: Content[]): Content[] {
  const merged: Content[] = [];
  const isFuncResp = (c: Content) =>
    c.role === 'user' && c.parts?.length && c.parts.every(p => p.functionResponse);
  let pending: Content | null = null;
  for (const content of contents) {
    if (isFuncResp(content)) {
      if (pending) {
        pending.parts!.push(...content.parts!);
      } else {
        pending = { role: 'user', parts: [...content.parts!] };
      }
    } else {
      if (pending) { merged.push(pending); pending = null; }
      merged.push(content);
    }
  }
  if (pending) merged.push(pending);
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

function resolveRef(schema: any, root: any): any {
  if (typeof schema !== 'object' || schema === null) return schema;
  const refValue = schema.$ref || schema.ref;
  if (refValue) {
    const defs = root.$defs || root.definitions || {};
    if (typeof refValue === 'string') {
      let defName: string | null = null;
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
            (resolved as any)[k] = schema[k];
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
    const result: any = {};
    for (const key of Object.keys(schema)) {
      result[key] = resolveRef(schema[key], root);
    }
    return result;
  }
  return schema;
}

export function sanitizeGeminiSchema(schema: any): any {
  if (typeof schema !== 'object' || schema === null) return schema;
  const resolved = resolveRef(schema, schema);
  const newSchema: { [key: string]: any } = {};
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
    const newProperties: { [key: string]: any } = {};
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
  private readonly config: Config;
  private readonly contentGenerator;
  private readonly debugMode: boolean;

  constructor(config: Config, debugMode = false) {
    this.config = config;
    this.contentGenerator = this.config.getGeminiClient().getContentGenerator();
    this.debugMode = debugMode;
  }

  private convertOpenAIToolsToGemini(
    openAITools?: OpenAIChatCompletionRequest['tools'],
  ): Tool[] | undefined {
    if (!openAITools || openAITools.length === 0) return undefined;
    const functionDeclarations: FunctionDeclaration[] = openAITools
      .filter(tool => tool.type === 'function' && tool.function)
      .map(tool => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: sanitizeGeminiSchema(tool.function.parameters),
      }));
    if (functionDeclarations.length === 0) return undefined;
    return [{ functionDeclarations }];
  }

  parseFunctionNameFromId(toolCallId: string): string {
    const parts = toolCallId.split('.');
    if (parts.length >= 2 && parts[0] === 'call') {
      return parts[1];
    }
    return 'unknown_tool_from_id';
  }

  private openAIMessageToGemini(msg: OpenAIMessage): Content {
    if (msg.role === 'assistant') {
      const parts: Part[] = [];
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
              const part: any = {
                functionCall: { name: fnName, args: argsObject },
              };
              if (sig) {
                part.thought = true;
                part.thoughtSignature = sig;
              } else {
                part.thoughtSignature = "skip_thought_signature_validator";
                part.thought = true;
              }
              parts.push(part);
            } catch (e) {
              logger.warn('Failed to parse tool call arguments', { arguments: toolCall.function.arguments }, e);
            }
          }
        }
      }
      return { role: 'model', parts };
    }

    if (msg.role === 'tool') {
      const functionName = this.parseFunctionNameFromId(msg.tool_call_id || '');
      let responsePayload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(msg.content as string);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          responsePayload = parsed as Record<string, unknown>;
        } else {
          responsePayload = { output: parsed };
        }
      } catch (e) {
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
      const parts = msg.content.reduce<Part[]>((acc, part: MessageContentPart) => {
        if (part.type === 'text') {
          acc.push({ text: part.text || '' });
        } else if (part.type === 'image_url' && part.image_url) {
          const imageUrl = part.image_url.url;
          if (imageUrl.startsWith('data:')) {
            const [mimePart, dataPart] = imageUrl.split(',');
            const mimeType = mimePart.split(':')[1].split(';')[0];
            acc.push({ inlineData: { mimeType, data: dataPart } });
          } else {
            acc.push({ fileData: { mimeType: 'image/jpeg', fileUri: imageUrl } });
          }
        }
        return acc;
      }, []);
      return { role, parts };
    }
    return { role, parts: [{ text: '' }] };
  }

  public async sendMessageStream({
    model,
    messages,
    tools,
    tool_choice,
  }: {
    model: string;
    messages: OpenAIMessage[];
    tools?: OpenAIChatCompletionRequest['tools'];
    tool_choice?: any;
  }): Promise<AsyncGenerator<StreamChunk>> {
    let clientSystemInstruction: Content | undefined = undefined;
    const useInternalPrompt = !!this.config.getUserMemory();

    if (!useInternalPrompt) {
      const systemMessageIndex = messages.findIndex(msg => msg.role === 'system');
      if (systemMessageIndex !== -1) {
        const systemMessage = messages.splice(systemMessageIndex, 1)[0];
        clientSystemInstruction = this.openAIMessageToGemini(systemMessage);
      }
    }

    const history = mergeFunctionResponseUserEntries(
      messages.map(msg => this.openAIMessageToGemini(msg)),
    );
    const lastMessage = history.pop();

    logger.info('Calling Gemini API', { model });
    logger.debug(this.debugMode, 'Sending request to Gemini', { historyLength: history.length, lastMessage });

    if (!lastMessage) throw new Error('No message to send.');

    if (model && typeof model === 'string') {
      try { this.config.setModel(model); } catch (e) { logger.warn('Failed to set model:', e); }
    }

    const oneShotChat = new GeminiChat(this.config, this.contentGenerator, {}, history);
    const geminiTools = this.convertOpenAIToolsToGemini(tools);
    const generationConfig: GenerateContentConfig = {};
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

    return (async function* (): AsyncGenerator<StreamChunk> {
      let pendingThoughtSig: string | null = null;
      for await (const response of geminiStream) {
        const parts = response.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          const partAny = part as any;
          const sig = partAny.thoughtSignature || null;
          if (sig) pendingThoughtSig = sig;
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
                args: (part.functionCall.args as Record<string, unknown>) ?? {},
                thoughtSignature: toolSig,
              } as { name: string; args: Record<string, unknown>; thoughtSignature?: string },
            } as StreamChunk;
          }
        }
      }
    })();
  }
}
