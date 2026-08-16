# Security

## Trust boundaries

- The transfer service listens on loopback. Public access goes through one explicitly configured
  reverse-proxy route.
- No media directory may sit under `DocumentRoot` or be reachable through a symlink that Apache
  serves statically.
- A transfer ticket is encrypted and authenticated with AES-256-GCM, has a short TTL and is issued
  only after the caller has been authorised.
- The browser works with a logical source identifier and a relative path. Python resolves the path
  again and verifies that it stays inside the allowed directory.
- Group limits that the transfer service enforces (simultaneous compatibility streams,
  simultaneous downloads) travel inside the ticket, so the service needs no database of its own.
- The transfer key and the database password exist only in the ignored `config.local.toml` or in
  environment variables.
- The installer restricts the ACL of the private configuration on Windows; on Debian it sets
  mode 0600.
- The metadata parser runs outside the scan, in a separate process killed after its timeout.
- Supply chain: Python dependencies are installed exclusively from hash-verified locks
  (`--require-hashes`, build backend included), the frontend from `package-lock.json`. CI and
  `scripts/check.py` scan the repository for secrets (including literal values taken from the
  private configuration) and audit dependencies. The PHP bridge parses the shared TOML with its
  own strict subset parser — unsupported constructs are rejected, never silently misread.

## Production settings

- Do not set `allow_remote_bind = true` unless a deliberately configured TLS layer and a firewall
  sit in front of the service.
- Turn off logging of full transfer URLs. A ticket is short-lived but it is still a secret.
- Use a dedicated database account limited to one database. Migrations may use a separate account
  (the runtime account deliberately lacks DDL rights).
- Once the Python service is deployed, block direct static serving of the legacy `sources`
  directories in Apache.
- Do not place the repository tree in a public directory on Debian.

## Known limitations

- A ticket is not registered in the database, so an individual ticket cannot be revoked before it
  expires. The short TTL bounds the risk; recorded grants are planned before the cutover.
- Replacing a symlink between validation and open is a local TOCTOU race. Source directories and
  their symlinks must stay under the administrator's control.
- The session cookie name is still shared with the legacy portal (`PHPSESSID`) during the staging
  period; splitting it is part of the controlled cutover.

## Reporting

Do not publish reports containing keys, passwords, private paths or sample tickets.
