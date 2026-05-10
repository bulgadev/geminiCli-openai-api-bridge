/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import path from 'node:path';

const globalNodeModules = '/opt/homebrew/lib/node_modules/@intelligentinternet/gemini-cli-mcp-openai-bridge/node_modules';

export default defineConfig({
  test: {
    include: ['bridge-server/src/*.test.ts'],
    alias: {
      '@google/gemini-cli-core': path.join(globalNodeModules, '@google/gemini-cli-core'),
    },
  },
});
