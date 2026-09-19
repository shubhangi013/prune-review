/**
 * Safety escarpment: patterns that override decision triage and force a hunk
 * to be kept. These are the "if triage says 'trivial' but the file matches this,
 * still send it to the LLM" backstop.
 *
 * Default set targets categories where a triage error is expensive:
 * concurrency primitives, auth/secret/token handling, security-sensitive
 * symbol families, startup/lifecycle code, and accessibility surfaces.
 *
 * Users may add project-specific patterns via `extraSafetyPatterns` in
 * OrchestratorConfig — critical for adapting to a specific codebase.
 */
export const DEFAULT_SAFETY_PATTERNS: RegExp[] = [
  // Concurrency / lifecycle
  /\bstd::(mutex|atomic|thread|condition_variable)\b/,
  /\b(async|await|Promise\.|goroutine|go\s+func)\b/,
  /\b(Startup|Launch|OnActivated|OnLaunched|main\s*\()/,

  // Auth / secrets / crypto
  /\b(auth|token|secret|password|credential|apikey|api_key|jwt|oauth|hmac|hash|crypt|cipher|tls|ssl)\b/i,
  /\b(GA_TOKEN_|ACCESS_TOKEN|REFRESH_TOKEN|SECRET_KEY)\b/,

  // Security-sensitive stdlib surfaces
  /\b(std::filesystem|std::system|exec|subprocess|child_process|os\.system|Runtime\.getRuntime)\b/,
  /\b(sql|query|prepare|execute)\b.*\b(user|input|param)\b/i,

  // Accessibility
  /\b(AutomationProperties|AriaLabel|aria-|screen[-\s]?reader|a11y|accessibility)\b/i,

  // Persistence / config
  /\b(ApplicationData|LocalFolder|LocalStorage|Preferences|Settings)\b/,
];

export interface SafetyChecker {
  check(filePath: string, hunk: string): { forced: boolean; reason?: string };
}

export function makeSafetyChecker(
  extraPatternSources: string[] = [],
): SafetyChecker {
  const patterns: RegExp[] = [
    ...DEFAULT_SAFETY_PATTERNS,
    ...extraPatternSources.map((src) => {
      // Accept either "/pat/flags" or bare "pat".
      const m = src.match(/^\/(.+)\/([gimsuy]*)$/);
      return m ? new RegExp(m[1], m[2]) : new RegExp(src);
    }),
  ];

  return {
    check(filePath, hunk) {
      const target = filePath + "\n" + hunk;
      for (const re of patterns) {
        if (re.test(target)) {
          return { forced: true, reason: re.source };
        }
      }
      return { forced: false };
    },
  };
}
