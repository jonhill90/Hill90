#!/usr/bin/env node
/**
 * Hill90 CLI — terminal interface for Hill90 agents.
 *
 * Usage:
 *   hill90 agents           — list agents
 *   hill90 chat <agent-id>  — start interactive chat with an agent
 *   hill90 threads          — list chat threads
 *   hill90 health           — check API health
 */

import { Command } from 'commander';
import * as readline from 'readline';
import { Hill90Client } from './api';

const API_URL = process.env.HILL90_API_URL || 'https://hill90.com/api';
const TOKEN = process.env.HILL90_TOKEN || '';

function getClient(): Hill90Client {
  if (!TOKEN) {
    console.error('Set HILL90_TOKEN environment variable (Keycloak access token)');
    process.exit(1);
  }
  return new Hill90Client(API_URL, TOKEN);
}

const program = new Command();
program
  .name('hill90')
  .description('CLI for Hill90 agent platform')
  .version('0.1.0');

program
  .command('health')
  .description('Check API health')
  .action(async () => {
    try {
      const client = getClient();
      const data = await client.health();
      console.log(`Status: ${data.status}`);
      console.log(`Service: ${data.service}`);
    } catch (err: any) {
      console.error('Health check failed:', err.message);
      process.exit(1);
    }
  });

program
  .command('agents')
  .description('List agents')
  .action(async () => {
    try {
      const client = getClient();
      const agents = await client.listAgents();
      if (!Array.isArray(agents) || agents.length === 0) {
        console.log('No agents found.');
        return;
      }
      console.log(`\n  ${'Name'.padEnd(25)} ${'Status'.padEnd(10)} Agent ID`);
      console.log(`  ${'─'.repeat(25)} ${'─'.repeat(10)} ${'─'.repeat(30)}`);
      for (const a of agents) {
        const status = a.status === 'running' ? '\x1b[32m●\x1b[0m running' : '\x1b[90m○\x1b[0m stopped';
        console.log(`  ${(a.name || '').padEnd(25)} ${status.padEnd(19)} ${a.agent_id}`);
      }
      console.log();
    } catch (err: any) {
      console.error('Failed to list agents:', err.message);
      process.exit(1);
    }
  });

program
  .command('threads')
  .description('List chat threads')
  .action(async () => {
    try {
      const client = getClient();
      const threads = await client.listThreads();
      if (!Array.isArray(threads) || threads.length === 0) {
        console.log('No threads found.');
        return;
      }
      for (const t of threads.slice(0, 20)) {
        const title = t.title || 'Untitled';
        const updated = t.updated_at ? new Date(t.updated_at).toLocaleString() : '';
        console.log(`  ${t.id.slice(0, 8)}  ${title.padEnd(30)}  ${updated}`);
      }
    } catch (err: any) {
      console.error('Failed to list threads:', err.message);
      process.exit(1);
    }
  });

program
  .command('chat <agent-id>')
  .description('Start interactive chat with an agent')
  .option('-t, --thread <id>', 'Continue existing thread')
  .action(async (agentId: string, opts: { thread?: string }) => {
    const client = getClient();

    let threadId = opts.thread;

    // Create or reuse thread
    if (!threadId) {
      try {
        const thread = await client.createThread(agentId);
        threadId = thread.id;
        console.log(`\x1b[90mThread created: ${threadId}\x1b[0m`);
      } catch (err: any) {
        console.error('Failed to create thread:', err.message);
        process.exit(1);
      }
    }

    console.log('\x1b[36mHill90 Chat\x1b[0m — type your message, press Enter to send. Ctrl+C to exit.\n');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '\x1b[32myou>\x1b[0m ',
    });

    rl.prompt();

    rl.on('line', async (line: string) => {
      const content = line.trim();
      if (!content) {
        rl.prompt();
        return;
      }

      try {
        await client.sendMessage(threadId!, content);
        process.stdout.write('\x1b[36magent>\x1b[0m ');

        // Stream response
        for await (const chunk of client.streamResponse(threadId!)) {
          process.stdout.write(chunk);
        }
        console.log('\n');
      } catch (err: any) {
        console.error(`\n\x1b[31mError: ${err.message}\x1b[0m\n`);
      }

      rl.prompt();
    });

    rl.on('close', () => {
      console.log('\nGoodbye.');
      process.exit(0);
    });
  });

program.parse();
