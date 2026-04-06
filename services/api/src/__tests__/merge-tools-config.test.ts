import { mergeToolsConfigs, DEFAULT_TOOLS_CONFIG, ToolsConfig } from '../services/merge-tools-config';

describe('mergeToolsConfigs', () => {
  // M1: Empty array returns no-skills default config
  it('returns default config for empty array', () => {
    const result = mergeToolsConfigs([]);
    expect(result).toEqual(DEFAULT_TOOLS_CONFIG);
    expect(result.shell.enabled).toBe(false);
    expect(result.filesystem.enabled).toBe(false);
    expect(result.health.enabled).toBe(true);
    expect(result.shell.max_timeout).toBe(300);
    expect(result.filesystem.read_only).toBe(false);
    expect(result.filesystem.allowed_paths).toEqual(['/workspace', '/home/agentuser']);
    expect(result.filesystem.denied_paths).toEqual([]);
  });

  // M2: Single config returns itself
  it('returns single config unchanged', () => {
    const single: ToolsConfig = {
      shell: { enabled: true, allowed_binaries: ['bash'], denied_patterns: ['rm -rf'], max_timeout: 600 },
      filesystem: { enabled: true, read_only: true, allowed_paths: ['/data'], denied_paths: ['/root'] },
      health: { enabled: false },
    };
    const result = mergeToolsConfigs([single]);
    expect(result).toBe(single); // Same reference
  });

  // M3: shell.enabled OR
  it('shell.enabled uses OR', () => {
    const a: ToolsConfig = {
      shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: false, read_only: false, allowed_paths: [], denied_paths: [] },
      health: { enabled: false },
    };
    const b: ToolsConfig = {
      shell: { enabled: true, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: false, read_only: false, allowed_paths: [], denied_paths: [] },
      health: { enabled: false },
    };
    expect(mergeToolsConfigs([a, b]).shell.enabled).toBe(true);
  });

  // M4: shell.allowed_binaries UNION
  it('shell.allowed_binaries uses UNION', () => {
    const a: ToolsConfig = {
      shell: { enabled: true, allowed_binaries: ['bash'], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: false, read_only: false, allowed_paths: [], denied_paths: [] },
      health: { enabled: true },
    };
    const b: ToolsConfig = {
      shell: { enabled: true, allowed_binaries: ['git'], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: false, read_only: false, allowed_paths: [], denied_paths: [] },
      health: { enabled: true },
    };
    const result = mergeToolsConfigs([a, b]);
    expect(result.shell.allowed_binaries.sort()).toEqual(['bash', 'git']);
  });

  // M5: shell.allowed_binaries empty-means-unrestricted
  it('shell.allowed_binaries empty array means unrestricted', () => {
    const a: ToolsConfig = {
      shell: { enabled: true, allowed_binaries: ['bash'], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: false, read_only: false, allowed_paths: [], denied_paths: [] },
      health: { enabled: true },
    };
    const b: ToolsConfig = {
      shell: { enabled: true, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: false, read_only: false, allowed_paths: [], denied_paths: [] },
      health: { enabled: true },
    };
    const result = mergeToolsConfigs([a, b]);
    expect(result.shell.allowed_binaries).toEqual([]);
  });

  // M6: shell.denied_patterns UNION
  it('shell.denied_patterns uses UNION', () => {
    const a: ToolsConfig = {
      shell: { enabled: true, allowed_binaries: [], denied_patterns: ['rm -rf'], max_timeout: 300 },
      filesystem: { enabled: false, read_only: false, allowed_paths: [], denied_paths: [] },
      health: { enabled: true },
    };
    const b: ToolsConfig = {
      shell: { enabled: true, allowed_binaries: [], denied_patterns: ['dd'], max_timeout: 300 },
      filesystem: { enabled: false, read_only: false, allowed_paths: [], denied_paths: [] },
      health: { enabled: true },
    };
    const result = mergeToolsConfigs([a, b]);
    expect(result.shell.denied_patterns.sort()).toEqual(['dd', 'rm -rf']);
  });

  // M7: shell.max_timeout MAX
  it('shell.max_timeout uses MAX', () => {
    const a: ToolsConfig = {
      shell: { enabled: true, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: false, read_only: false, allowed_paths: [], denied_paths: [] },
      health: { enabled: true },
    };
    const b: ToolsConfig = {
      shell: { enabled: true, allowed_binaries: [], denied_patterns: [], max_timeout: 600 },
      filesystem: { enabled: false, read_only: false, allowed_paths: [], denied_paths: [] },
      health: { enabled: true },
    };
    expect(mergeToolsConfigs([a, b]).shell.max_timeout).toBe(600);
  });

  // M8: filesystem.enabled OR
  it('filesystem.enabled uses OR', () => {
    const a: ToolsConfig = {
      shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: false, read_only: false, allowed_paths: [], denied_paths: [] },
      health: { enabled: true },
    };
    const b: ToolsConfig = {
      shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: [], denied_paths: [] },
      health: { enabled: true },
    };
    expect(mergeToolsConfigs([a, b]).filesystem.enabled).toBe(true);
  });

  // M9: filesystem.read_only AND
  it('filesystem.read_only uses AND', () => {
    const a: ToolsConfig = {
      shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: true, read_only: true, allowed_paths: [], denied_paths: [] },
      health: { enabled: true },
    };
    const b: ToolsConfig = {
      shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: [], denied_paths: [] },
      health: { enabled: true },
    };
    // false if any is false
    expect(mergeToolsConfigs([a, b]).filesystem.read_only).toBe(false);

    // true only if all are true
    const c: ToolsConfig = { ...a, filesystem: { ...a.filesystem, read_only: true } };
    const d: ToolsConfig = { ...b, filesystem: { ...b.filesystem, read_only: true } };
    expect(mergeToolsConfigs([c, d]).filesystem.read_only).toBe(true);
  });

  // M10: filesystem.allowed_paths UNION
  it('filesystem.allowed_paths uses UNION', () => {
    const a: ToolsConfig = {
      shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace'], denied_paths: [] },
      health: { enabled: true },
    };
    const b: ToolsConfig = {
      shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/data'], denied_paths: [] },
      health: { enabled: true },
    };
    const result = mergeToolsConfigs([a, b]);
    expect(result.filesystem.allowed_paths.sort()).toEqual(['/data', '/workspace']);
  });

  // M11: filesystem.denied_paths UNION
  it('filesystem.denied_paths uses UNION', () => {
    const a: ToolsConfig = {
      shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: [], denied_paths: ['/etc/shadow'] },
      health: { enabled: true },
    };
    const b: ToolsConfig = {
      shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: [], denied_paths: ['/root'] },
      health: { enabled: true },
    };
    const result = mergeToolsConfigs([a, b]);
    expect(result.filesystem.denied_paths.sort()).toEqual(['/etc/shadow', '/root']);
  });

  // M12: health.enabled OR
  it('health.enabled uses OR', () => {
    const a: ToolsConfig = {
      shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: false, read_only: false, allowed_paths: [], denied_paths: [] },
      health: { enabled: false },
    };
    const b: ToolsConfig = {
      shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: false, read_only: false, allowed_paths: [], denied_paths: [] },
      health: { enabled: true },
    };
    expect(mergeToolsConfigs([a, b]).health.enabled).toBe(true);
  });

  // M13: Full 3-config merge
  it('merges 3 configs with all fields correctly', () => {
    const a: ToolsConfig = {
      shell: { enabled: true, allowed_binaries: ['bash'], denied_patterns: ['rm -rf'], max_timeout: 300 },
      filesystem: { enabled: true, read_only: true, allowed_paths: ['/workspace'], denied_paths: ['/etc/shadow'] },
      health: { enabled: true },
    };
    const b: ToolsConfig = {
      shell: { enabled: false, allowed_binaries: ['git'], denied_patterns: ['dd'], max_timeout: 600 },
      filesystem: { enabled: false, read_only: true, allowed_paths: ['/data'], denied_paths: ['/root'] },
      health: { enabled: false },
    };
    const c: ToolsConfig = {
      shell: { enabled: true, allowed_binaries: ['make', 'bash'], denied_patterns: ['rm -rf'], max_timeout: 120 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/tmp'], denied_paths: [] },
      health: { enabled: true },
    };

    const result = mergeToolsConfigs([a, b, c]);

    // shell: OR → true; UNION binaries; UNION denied; MAX timeout
    expect(result.shell.enabled).toBe(true);
    expect(result.shell.allowed_binaries.sort()).toEqual(['bash', 'git', 'make']);
    expect(result.shell.denied_patterns.sort()).toEqual(['dd', 'rm -rf']);
    expect(result.shell.max_timeout).toBe(600);

    // filesystem: OR → true; AND read_only → false (c is false); UNION paths
    expect(result.filesystem.enabled).toBe(true);
    expect(result.filesystem.read_only).toBe(false);
    expect(result.filesystem.allowed_paths.sort()).toEqual(['/data', '/tmp', '/workspace']);
    expect(result.filesystem.denied_paths.sort()).toEqual(['/etc/shadow', '/root']);

    // health: OR → true
    expect(result.health.enabled).toBe(true);
  });

  // M14: Deduplication
  it('UNION lists have no duplicates', () => {
    const a: ToolsConfig = {
      shell: { enabled: true, allowed_binaries: ['bash', 'git'], denied_patterns: ['rm -rf'], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace'], denied_paths: ['/etc/shadow'] },
      health: { enabled: true },
    };
    const b: ToolsConfig = {
      shell: { enabled: true, allowed_binaries: ['bash', 'make'], denied_patterns: ['rm -rf', 'dd'], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/data'], denied_paths: ['/etc/shadow', '/root'] },
      health: { enabled: true },
    };

    const result = mergeToolsConfigs([a, b]);

    // No duplicate entries
    expect(result.shell.allowed_binaries.filter((v, i, arr) => arr.indexOf(v) !== i)).toEqual([]);
    expect(result.shell.denied_patterns.filter((v, i, arr) => arr.indexOf(v) !== i)).toEqual([]);
    expect(result.filesystem.allowed_paths.filter((v, i, arr) => arr.indexOf(v) !== i)).toEqual([]);
    expect(result.filesystem.denied_paths.filter((v, i, arr) => arr.indexOf(v) !== i)).toEqual([]);

    // Correct values
    expect(result.shell.allowed_binaries.sort()).toEqual(['bash', 'git', 'make']);
    expect(result.shell.denied_patterns.sort()).toEqual(['dd', 'rm -rf']);
    expect(result.filesystem.allowed_paths.sort()).toEqual(['/data', '/workspace']);
    expect(result.filesystem.denied_paths.sort()).toEqual(['/etc/shadow', '/root']);
  });

  // T24: Merge behavior with base + overlay configs
  it('mergeToolsConfigs with base + overlay', () => {
    const baseConfig: ToolsConfig = {
      shell: { enabled: true, allowed_binaries: ['bash', 'git', 'make'], denied_patterns: ['rm -rf /'], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/data'], denied_paths: ['/etc/shadow', '/etc/passwd', '/root'] },
      health: { enabled: true },
    };

    const overlayConfig: ToolsConfig = {
      shell: { enabled: true, allowed_binaries: ['python3'], denied_patterns: ['eval'], max_timeout: 600 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/opt/data'], denied_paths: [] },
      health: { enabled: true },
    };

    const result = mergeToolsConfigs([baseConfig, overlayConfig]);

    // shell.enabled: OR → true
    expect(result.shell.enabled).toBe(true);
    // shell.allowed_binaries: UNION of base + overlay
    expect(result.shell.allowed_binaries).toContain('bash');
    expect(result.shell.allowed_binaries).toContain('git');
    expect(result.shell.allowed_binaries).toContain('make');
    expect(result.shell.allowed_binaries).toContain('python3');
    // shell.denied_patterns: UNION
    expect(result.shell.denied_patterns).toContain('rm -rf /');
    expect(result.shell.denied_patterns).toContain('eval');
    // shell.max_timeout: MAX(300, 600)
    expect(result.shell.max_timeout).toBe(600);
    // filesystem.enabled: OR → true
    expect(result.filesystem.enabled).toBe(true);
    // filesystem.read_only: AND → false (both false)
    expect(result.filesystem.read_only).toBe(false);
    // filesystem.allowed_paths: UNION
    expect(result.filesystem.allowed_paths).toContain('/workspace');
    expect(result.filesystem.allowed_paths).toContain('/data');
    expect(result.filesystem.allowed_paths).toContain('/opt/data');
    // filesystem.denied_paths: UNION
    expect(result.filesystem.denied_paths).toContain('/etc/shadow');
    expect(result.filesystem.denied_paths).toContain('/etc/passwd');
    expect(result.filesystem.denied_paths).toContain('/root');
    // health.enabled: OR → true
    expect(result.health.enabled).toBe(true);
  });
});
