# Security Considerations

This document outlines security considerations when using Pi coding agent.

## Bash Tool Command Execution (#337)

The bash tool executes commands directly on the host system **by design**.

### Intentional Design
- Full shell access is required for the agent to be useful as a coding assistant
- Commands are executed with the permissions of the user running Pi
- No command sanitization or sandboxing is applied

### Risks
- **Prompt injection**: A malicious user could craft inputs that trick the LLM into executing harmful commands
- **Exfiltration**: Sensitive data could be read and exposed via command output
- **System modification**: Commands can modify files, install software, etc.

### Mitigations
- Run Pi with minimal necessary permissions
- Use in trusted environments only
- Review suggested commands before execution in permission modes
- Consider network isolation for sensitive environments

### Future Considerations
- Configurable command allowlist/denylist (not yet implemented)
- Sandboxed execution environments (not yet implemented)

## Path Resolution (#338)

Two path resolution utilities exist:

### `resolveToCwd(path)`
- Resolves paths relative to current working directory
- **Does NOT** restrict paths to stay within cwd
- Use when: User explicitly requests access to files outside cwd

### `resolveToCwdSafe(path)`
- Resolves paths relative to cwd AND validates containment
- **Throws** if resolved path would escape cwd
- Use when: Path comes from untrusted input or should be restricted

### Why Default Allows Outside-CWD Access
Users legitimately need to:
- Read system config files (e.g., `/etc/hosts`)
- Access home directory files (e.g., `~/.ssh/config`)
- Work across multiple project directories

The agent operates with user permissions; restricting paths would reduce utility without adding security (user can just change cwd).

## API Key Handling

API keys are:
- Read from environment variables (recommended)
- Never logged in plain text (redacted in debug output)
- Passed securely to provider SDKs

### Best Practices
- Use environment variables, not config files
- Rotate keys regularly
- Use provider-specific minimum-privilege API keys

## Proxy Configuration

When using proxy streaming:
- Validate proxy URL belongs to trusted hosts
- SSRF protection blocks dangerous patterns (metadata endpoints, private IPs)
- Credentials are only sent to validated proxy endpoints

See `packages/agent/src/proxy.ts` for implementation details.
