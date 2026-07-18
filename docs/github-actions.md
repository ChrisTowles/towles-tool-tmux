# GitHub Actions

## Automated Release

Trigger via GitHub Actions:

```bash
gh workflow run release.yml -f bump_type=patch  # or minor/major
gh run watch  # monitor progress
```

The workflow:

1. Runs CI (lint, typecheck, test)
2. Bumps version in package.json
3. Commits and tags
4. Creates GitHub release
5. Publishes to npm

## Branch Protection & Deploy Key Setup

The release workflow needs to push directly to `main`, but branch protection requires CI to pass first. This creates a chicken-and-egg problem since new commits can't pass CI before being pushed.

**Solution:** Deploy key with ruleset bypass.

### How It Works

1. **Deploy Key** - SSH key with write access, stored as `DEPLOY_KEY` secret
2. **Ruleset** - GitHub ruleset requires CI for all users, but allows deploy keys to bypass
3. **SSH Authentication** - Release workflow uses `webfactory/ssh-agent` to authenticate via SSH instead of HTTPS

### Setup Steps (if recreating)

```bash
# 1. Generate deploy key
ssh-keygen -t ed25519 -C "github-actions@github.com" -N "" -f ./deploy-key

# 2. Add public key to GitHub deploy keys (with write access)
gh repo deploy-key add ./deploy-key.pub --title "Release Workflow" --allow-write

# 3. Add private key as repository secret
gh secret set DEPLOY_KEY < ./deploy-key

# 4. Create ruleset with deploy key bypass (via GitHub UI or API)
# Settings → Rules → Rulesets → Add deploy key to bypass list

# 5. Clean up local key files
rm ./deploy-key ./deploy-key.pub
```

### Workflow Configuration

```yaml
- uses: actions/checkout@v4
  with:
    persist-credentials: false

- uses: webfactory/ssh-agent@v0.9.0
  with:
    ssh-private-key: ${{ secrets.DEPLOY_KEY }}

- run: git remote set-url origin git@github.com:OWNER/REPO.git
```
