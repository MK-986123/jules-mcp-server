#!/usr/bin/env node
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const serverPath = path.join(projectRoot, 'dist', 'index.js');

const client = new Client(
  { name: 'mcp-smoke-client', version: '0.0.1' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } }
);
const transport = new StdioClientTransport({
  command: 'node',
  args: [serverPath],
  env: { ...process.env, JULES_API_KEY: process.env.JULES_API_KEY ?? 'dummy' },
  cwd: projectRoot,
  stderr: 'pipe',
});

async function verifyLegacyCompatibility() {
  const legacyClient = new Client({
    name: 'mcp-legacy-smoke-client',
    version: '0.0.1',
  });
  const legacyTransport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env: { ...process.env, JULES_API_KEY: process.env.JULES_API_KEY ?? 'dummy' },
    cwd: projectRoot,
    stderr: 'pipe',
  });

  try {
    await legacyClient.connect(legacyTransport);
    const tools = await legacyClient.listTools();
    if (!tools.tools.some((tool) => tool.name === 'list_sources')) {
      throw new Error('Legacy protocol did not expose the list_sources tool');
    }
    const schedules = await legacyClient.callTool({
      name: 'list_schedules',
      arguments: {},
    });
    if (schedules.isError) {
      throw new Error('Legacy protocol read-only tool call failed');
    }
    console.log(
      `[mcp:smoke] legacy protocol tools: ${tools.tools.length}; read-only tool succeeded`
    );
  } finally {
    await legacyClient.close().catch(() => {});
    await legacyTransport.close().catch(() => {});
  }
}

async function main() {
  await client.connect(transport);

  const tools = await client.listTools();
  console.log(`[mcp:smoke] tools: ${tools.tools.length}`);
  const listSources = tools.tools.find((tool) => tool.name === 'list_sources');
  const deleteSession = tools.tools.find((tool) => tool.name === 'delete_session');
  if (!listSources?.inputSchema || !listSources.outputSchema) {
    throw new Error('list_sources is missing tool input/output schemas');
  }
  if (listSources.annotations?.readOnlyHint !== true) {
    throw new Error('list_sources is missing its read-only annotation');
  }
  if (deleteSession?.annotations?.destructiveHint !== true) {
    throw new Error('delete_session is missing its destructive annotation');
  }

  const discovery = await client.discover();
  console.log(`[mcp:smoke] protocol discovery: ${JSON.stringify(discovery)}`);

  const prompts = await client.listPrompts();
  console.log(`[mcp:smoke] prompts: ${prompts.prompts.length}`);

  const resources = await client.listResources();
  console.log(
    `[mcp:smoke] resources: ${resources.resources.map((r) => r.uri).join(', ')}`
  );
  if (resources.resources.some((resource) => resource.uri.includes('{'))) {
    throw new Error('Parameterized resources were advertised as concrete resources');
  }
  const templates = await client.listResourceTemplates();
  const templateUris = templates.resourceTemplates.map(
    (template) => template.uriTemplate
  );
  for (const suffix of ['activities', 'full', 'diff']) {
    if (!templateUris.includes(`jules://sessions/{id}/${suffix}`)) {
      throw new Error(`Missing session ${suffix} resource template`);
    }
  }
  console.log(`[mcp:smoke] resource templates: ${templateUris.join(', ')}`);

  const schedules = await client.callTool({
    name: 'list_schedules',
    arguments: {},
  });
  if (schedules.isError || !schedules.structuredContent) {
    throw new Error('Read-only tool call failed to return structured content');
  }
  console.log('[mcp:smoke] read-only tool returned structured content');
  await verifyLegacyCompatibility();
}

main()
  .catch((error) => {
    console.error('[mcp:smoke] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await client.close();
    } catch {}
    try {
      await transport.close();
    } catch {}
  });
