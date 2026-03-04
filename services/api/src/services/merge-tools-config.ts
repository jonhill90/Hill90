export interface ShellConfig {
  enabled: boolean;
  allowed_binaries: string[];
  denied_patterns: string[];
  max_timeout: number;
}

export interface FilesystemConfig {
  enabled: boolean;
  read_only: boolean;
  allowed_paths: string[];
  denied_paths: string[];
}

export interface HealthConfig {
  enabled: boolean;
}

export interface ToolsConfig {
  shell: ShellConfig;
  filesystem: FilesystemConfig;
  health: HealthConfig;
}

// No-skills default: matches routes/agents.ts:140 and agentbox config.py Pydantic defaults.
// Shell disabled, filesystem disabled, health enabled.
// Sub-field defaults from agentbox Pydantic: allowed_binaries=[], denied_patterns=[],
// max_timeout=300, read_only=false, allowed_paths=['/workspace'],
// denied_paths=['/etc/shadow','/etc/passwd','/root'].
export const DEFAULT_TOOLS_CONFIG: ToolsConfig = {
  shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
  filesystem: { enabled: false, read_only: false, allowed_paths: ['/workspace'], denied_paths: ['/etc/shadow', '/etc/passwd', '/root'] },
  health: { enabled: true },
};

/**
 * Merge multiple ToolsConfig objects into one using deterministic, order-independent rules.
 *
 * | Field                      | Rule                              |
 * |----------------------------|-----------------------------------|
 * | shell.enabled              | OR — any skill needs shell → on   |
 * | shell.allowed_binaries     | UNION, but empty [] = unrestricted (policy.py:41) |
 * | shell.denied_patterns      | UNION — denials accumulate        |
 * | shell.max_timeout          | MAX — most permissive wins        |
 * | filesystem.enabled         | OR                                |
 * | filesystem.read_only       | AND — false if any skill needs write |
 * | filesystem.allowed_paths   | UNION                             |
 * | filesystem.denied_paths    | UNION — denials accumulate        |
 * | health.enabled             | OR                                |
 */
export function mergeToolsConfigs(configs: ToolsConfig[]): ToolsConfig {
  if (configs.length === 0) return DEFAULT_TOOLS_CONFIG;
  if (configs.length === 1) return configs[0];

  const dedupe = (arr: string[]) => [...new Set(arr)];
  // Empty array in allowed_binaries means unrestricted (agentbox policy.py line 41:
  // `if self.allowed:` — empty set is falsy, so everything is allowed).
  const anyUnrestricted = configs.some(c => c.shell.allowed_binaries.length === 0);

  return {
    shell: {
      enabled: configs.some(c => c.shell.enabled),
      allowed_binaries: anyUnrestricted
        ? []
        : dedupe(configs.flatMap(c => c.shell.allowed_binaries)),
      denied_patterns: dedupe(configs.flatMap(c => c.shell.denied_patterns)),
      max_timeout: Math.max(...configs.map(c => c.shell.max_timeout)),
    },
    filesystem: {
      enabled: configs.some(c => c.filesystem.enabled),
      read_only: configs.every(c => c.filesystem.read_only),
      allowed_paths: dedupe(configs.flatMap(c => c.filesystem.allowed_paths)),
      denied_paths: dedupe(configs.flatMap(c => c.filesystem.denied_paths)),
    },
    health: {
      enabled: configs.some(c => c.health.enabled),
    },
  };
}
