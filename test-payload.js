import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: 'fake' });
const req = {
  contents: [
    { role: 'user', parts: [{ text: 'hi' }] },
    {
      role: 'model',
      parts: [
        { thought: true, thoughtSignature: 'b64==', functionCall: { name: 'foo', args: {} } }
      ]
    }
  ]
};
// We can't easily see the internal representation, but we can look at how toObject works.
console.log(JSON.stringify(req, null, 2));
