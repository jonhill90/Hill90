import { ToolsConfig } from './merge-tools-config';

export const SANDBOX_PROFILES: Record<string, ToolsConfig> = {
  minimal: {
    shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
    filesystem: { enabled: false, read_only: false, allowed_paths: ['/workspace'], denied_paths: ['/etc/shadow', '/etc/passwd', '/root'] },
    health: { enabled: true },
  },
  developer: {
    shell: { enabled: true, allowed_binaries: ['bash', 'git', 'make', 'curl', 'jq'], denied_patterns: ['rm -rf /', ':(){ :|:& };:'], max_timeout: 300 },
    filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/data'], denied_paths: ['/etc/shadow', '/etc/passwd', '/root'] },
    health: { enabled: true },
  },
  research: {
    shell: { enabled: true, allowed_binaries: ['bash', 'curl', 'wget', 'jq'], denied_patterns: ['rm ', 'mv ', 'dd ', 'mkfs', '> /', '>> /'], max_timeout: 120 },
    filesystem: { enabled: true, read_only: true, allowed_paths: ['/workspace', '/data'], denied_paths: ['/etc/shadow', '/etc/passwd', '/root'] },
    health: { enabled: true },
  },
  operator: {
    shell: { enabled: true, allowed_binaries: ['bash', 'git', 'curl', 'wget', 'jq', 'rsync', 'ssh', 'make', 'vim'], denied_patterns: ['rm -rf /', ':(){ :|:& };:'], max_timeout: 600 },
    filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/data', '/var/log/agentbox'], denied_paths: ['/etc/shadow', '/etc/passwd', '/root'] },
    health: { enabled: true },
  },
};

export const VALID_SANDBOX_PROFILES = Object.keys(SANDBOX_PROFILES);

export function getSandboxProfileConfig(name: string): ToolsConfig | undefined {
  return SANDBOX_PROFILES[name.toLowerCase()];
}
