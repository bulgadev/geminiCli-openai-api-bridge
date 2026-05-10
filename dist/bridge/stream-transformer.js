import { randomUUID } from 'node:crypto';
// --- New Stateful Transformer ---
export function createOpenAIStreamTransformer(model, debugMode = false) {
    const chatID = `chatcmpl-${randomUUID()}`;
    const creationTime = Math.floor(Date.now() / 1000);
    const encoder = new TextEncoder();
    let isFirstChunk = true;
    let toolCallIndex = 0;
    const createChunk = (delta, finish_reason = null) => ({
        id: chatID,
        object: 'chat.completion.chunk',
        created: creationTime,
        model: model,
        choices: [
            {
                index: 0,
                delta,
                finish_reason,
            },
        ],
    });
    const enqueueChunk = (controller, chunk) => {
        const sseString = `data: ${JSON.stringify(chunk)}\n\n`;
        controller.enqueue(encoder.encode(sseString));
    };
    return new TransformStream({
        transform(chunk, controller) {
            if (debugMode) {
                console.log(`[Stream Transformer] Received chunk: ${chunk.type}`, chunk.data ? JSON.stringify(chunk.data) : '');
            }
            let delta = {};
            if (isFirstChunk) {
                delta.role = 'assistant';
                isFirstChunk = false;
            }
            switch (chunk.type) {
                case 'text':
                    if (chunk.data) {
                        delta.content = chunk.data;
                        enqueueChunk(controller, createChunk(delta));
                    }
                    break;
                case 'tool_code': {
                    const { name, args, thoughtSignature } = chunk.data;
                    const sigPart = thoughtSignature ? `.${thoughtSignature}` : '';
                    const toolCallId = `call.${name}${sigPart}.${randomUUID()}`;
                    // OpenAI streaming tool calls need to be sent in chunks.
                    // 1. Send the chunk containing the function name.
                    const nameDelta = {
                        ...delta, // Include role if it's the first chunk
                        tool_calls: [
                            {
                                index: toolCallIndex,
                                id: toolCallId,
                                type: 'function',
                                function: { name: name, arguments: '' },
                            },
                        ],
                    };
                    enqueueChunk(controller, createChunk(nameDelta));
                    // 2. Send the chunk containing the arguments.
                    const argsDelta = {
                        tool_calls: [
                            {
                                index: toolCallIndex,
                                id: toolCallId,
                                type: 'function',
                                function: { arguments: JSON.stringify(args) },
                            },
                        ],
                    };
                    enqueueChunk(controller, createChunk(argsDelta));
                    toolCallIndex++;
                    break;
                }
                case 'reasoning':
                    // These events currently have no direct equivalent in the OpenAI format and can be ignored or logged.
                    if (debugMode) {
                        console.log(`[Stream Transformer] Ignoring chunk: ${chunk.type}`);
                    }
                    break;
            }
        },
        flush(controller) {
            // At the end of the stream, send a finish_reason of 'tool_calls' or 'stop'.
            const finish_reason = toolCallIndex > 0 ? 'tool_calls' : 'stop';
            enqueueChunk(controller, createChunk({}, finish_reason));
            const doneString = `data: [DONE]\n\n`;
            controller.enqueue(encoder.encode(doneString));
        },
    });
}
