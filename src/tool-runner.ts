#!/usr/bin/env bun
/**
 * CLI Tool Runner for Claude Code integration.
 *
 * Usage:
 *   bun run src/tool-runner.ts list                          # List all tools with schemas
 *   bun run src/tool-runner.ts call <tool_name> '<json>'     # Invoke a tool
 *   bun run src/tool-runner.ts describe <tool_name>          # Show tool schema details
 *   bun run src/tool-runner.ts skills                        # List available skills
 *   bun run src/tool-runner.ts skill <skill_name>            # Show skill instructions
 *
 * This bypasses the TUI and LLM agent loop, allowing Claude Code to directly
 * invoke Sapiens tools and get structured JSON results.
 */
import { config } from 'dotenv';
import { StructuredToolInterface } from '@langchain/core/tools';

config({ quiet: true });

// ── Import all direct tools (no LLM dependency) ──

// Market data sub-tools (bypass the LLM-routing meta-tool)
import { getPrice, getPriceHistory, listInstruments } from './tools/forex/market-data.js';
import { getTechnicalIndicator, getMultiIndicators } from './tools/forex/technical-analysis.js';

// Statistical analysis
import { getZScore, getCorrelationMatrix, getReturnDistribution, getVolatilityRegime } from './tools/forex/statistical-analysis.js';

// Macro analysis
import { getRateDifferential, getMacroRegime, getCrossAssetRegime } from './tools/forex/macro-analysis.js';

// Quant strategy
import { backtestStrategy, monteCarloSimulation, calculateExpectedValue } from './tools/forex/quant-strategy.js';

// Economic calendar
import { getEconomicCalendar } from './tools/forex/economic-calendar.js';

// Fintokei rules & risk
import { getFintokeiRules, calculatePositionSize, checkAccountHealth } from './tools/forex/fintokei-rules.js';

// Trade journal
import { recordTrade, closeTrade, getTradeStats, getTradeHistory } from './tools/forex/trade-journal.js';

// Web fetch
import { webFetchTool } from './tools/fetch/web-fetch.js';

// Skills
import { discoverSkills, getSkill } from './skills/index.js';

// ── Build tool registry ──

const ALL_TOOLS: StructuredToolInterface[] = [
  // Market Data (direct sub-tools, no LLM routing needed)
  getPrice,
  getPriceHistory,
  listInstruments,
  getTechnicalIndicator,
  getMultiIndicators,

  // Statistical Analysis
  getZScore,
  getCorrelationMatrix,
  getReturnDistribution,
  getVolatilityRegime,

  // Macro Analysis
  getRateDifferential,
  getMacroRegime,
  getCrossAssetRegime,

  // Quant Strategy
  backtestStrategy,
  monteCarloSimulation,
  calculateExpectedValue,

  // Economic Calendar
  getEconomicCalendar,

  // Fintokei Rules & Risk
  getFintokeiRules,
  calculatePositionSize,
  checkAccountHealth,

  // Trade Journal
  recordTrade,
  closeTrade,
  getTradeStats,
  getTradeHistory,

  // Web
  webFetchTool,
];

const TOOL_MAP = new Map(ALL_TOOLS.map(t => [t.name, t]));

// ── Extract Zod schema as JSON-friendly description ──

function describeZodField(field: any): Record<string, unknown> {
  const zodDef = field?._zod?.def;
  if (!zodDef) {
    // Fallback for Zod v3 style
    return {
      type: field._def?.typeName ?? 'unknown',
      description: field._def?.description ?? field.description ?? '',
    };
  }

  const desc = field.description ?? zodDef.description ?? '';

  const result: Record<string, unknown> = {
    type: zodDef.type,
    description: desc,
  };

  // Unwrap wrappers (optional, default)
  if (zodDef.type === 'optional') {
    const inner = describeZodField(zodDef.innerType);
    return { ...inner, optional: true, description: desc || inner.description };
  }
  if (zodDef.type === 'default') {
    const inner = describeZodField(zodDef.innerType);
    const defaultVal = typeof zodDef.defaultValue === 'function' ? zodDef.defaultValue() : zodDef.defaultValue;
    return { ...inner, default: defaultVal, description: desc || inner.description };
  }
  if (zodDef.type === 'enum' && zodDef.entries) {
    result.values = Object.keys(zodDef.entries);
  }

  return result;
}

function describeSchema(tool: StructuredToolInterface): Record<string, unknown> {
  try {
    const schema = (tool as any).schema;
    if (schema && typeof schema.shape === 'object') {
      const fields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(schema.shape)) {
        fields[key] = describeZodField(value);
      }
      return fields;
    }
  } catch {
    // fallback
  }
  return {};
}

// ── Commands ──

const [command, ...args] = process.argv.slice(2);

if (!command || command === 'help') {
  console.log(`Sapiens Tool Runner - Claude Code Integration

Usage:
  bun run src/tool-runner.ts list                        List all available tools
  bun run src/tool-runner.ts call <tool> '<json_args>'   Call a tool with JSON arguments
  bun run src/tool-runner.ts describe <tool>             Show detailed schema for a tool
  bun run src/tool-runner.ts skills                      List available multi-step skills
  bun run src/tool-runner.ts skill <name>                Show skill instructions

Available tools: ${Array.from(TOOL_MAP.keys()).join(', ')}
`);
  process.exit(0);
}

if (command === 'list') {
  const tools = ALL_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    schema: describeSchema(t),
  }));
  console.log(JSON.stringify(tools, null, 2));
  process.exit(0);
}

if (command === 'describe') {
  const toolName = args[0];
  if (!toolName) {
    console.error('Usage: bun run src/tool-runner.ts describe <tool_name>');
    process.exit(1);
  }
  const tool = TOOL_MAP.get(toolName);
  if (!tool) {
    console.error(`Unknown tool: ${toolName}\nAvailable: ${Array.from(TOOL_MAP.keys()).join(', ')}`);
    process.exit(1);
  }
  console.log(JSON.stringify({
    name: tool.name,
    description: tool.description,
    schema: describeSchema(tool),
  }, null, 2));
  process.exit(0);
}

if (command === 'call') {
  const toolName = args[0];
  const rawArgs = args[1] || '{}';

  if (!toolName) {
    console.error('Usage: bun run src/tool-runner.ts call <tool_name> \'<json_args>\'');
    process.exit(1);
  }

  const tool = TOOL_MAP.get(toolName);
  if (!tool) {
    console.error(`Unknown tool: ${toolName}\nAvailable: ${Array.from(TOOL_MAP.keys()).join(', ')}`);
    process.exit(1);
  }

  let parsedArgs: Record<string, unknown>;
  try {
    parsedArgs = JSON.parse(rawArgs);
  } catch (e) {
    console.error(`Invalid JSON arguments: ${rawArgs}`);
    process.exit(1);
  }

  try {
    const result = await tool.invoke(parsedArgs);
    // Result is already JSON string from formatToolResult
    try {
      // Pretty-print if it's valid JSON
      const parsed = JSON.parse(result as string);
      console.log(JSON.stringify(parsed, null, 2));
    } catch {
      console.log(result);
    }
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      tool: toolName,
      args: parsedArgs,
    }, null, 2));
    process.exit(1);
  }
  process.exit(0);
}

if (command === 'skills') {
  const skills = discoverSkills();
  console.log(JSON.stringify(skills.map(s => ({
    name: s.name,
    description: s.description,
  })), null, 2));
  process.exit(0);
}

if (command === 'skill') {
  const skillName = args[0];
  if (!skillName) {
    console.error('Usage: bun run src/tool-runner.ts skill <skill_name>');
    process.exit(1);
  }
  const skill = getSkill(skillName);
  if (!skill) {
    console.error(`Unknown skill: ${skillName}`);
    process.exit(1);
  }
  console.log(`# ${skill.name}\n\n${skill.description}\n\n## Instructions\n\n${skill.instructions}`);
  process.exit(0);
}

console.error(`Unknown command: ${command}\nRun 'bun run src/tool-runner.ts help' for usage.`);
process.exit(1);
