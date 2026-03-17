# AliYunFuWuQi SSH Access

This folder holds repo-local SSH connection materials for the Alibaba Cloud ECS host:

- Host alias: `aliyun-ubuntu`
- Host: `101.200.135.73`
- User: `admin`
- Port: `22`

It does not store private keys. The private key is expected at:

- `%USERPROFILE%\.ssh\aliyun_admin_ed25519`

## Files

- `ssh_config`: OpenSSH host definition for terminal and VS Code Remote-SSH
- `connect_aliyun.ps1`: consistent PowerShell entrypoint
- `.gitignore`: prevents accidental commits of local SSH materials

## Terminal Usage

Run from the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\ALiYunFuWuQi\connect_aliyun.ps1
```

Or pass extra SSH arguments:

```powershell
powershell -ExecutionPolicy Bypass -File .\ALiYunFuWuQi\connect_aliyun.ps1 -- hostname
```

Equivalent direct SSH command:

```powershell
ssh -F .\ALiYunFuWuQi\ssh_config aliyun-ubuntu
```

## First Login: Password Verification

Use the connection script first. Because the host currently allows both password and public key authentication, SSH will fall back to password if the dedicated key is not installed yet.

Expected first milestone:

- `connect_aliyun.ps1` opens an `admin@...` shell
- password login succeeds

If password login fails, use Alibaba Cloud console access or reset the `admin` password first.

If you only know the `root` password, you can still bootstrap the setup by logging in as `root` through another SSH session or Alibaba Cloud console access, then installing the dedicated public key into `/home/admin/.ssh/authorized_keys`.

## Generate Dedicated Local Key

Generate a dedicated key pair instead of reusing a default key:

```powershell
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\aliyun_admin_ed25519 -C "admin@101.200.135.73"
```

This should create:

- `%USERPROFILE%\.ssh\aliyun_admin_ed25519`
- `%USERPROFILE%\.ssh\aliyun_admin_ed25519.pub`

## Install the Public Key on the Server

After password login succeeds, run these commands inside the remote `admin` shell:

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
cat >> ~/.ssh/authorized_keys
```

Then paste the full contents of `%USERPROFILE%\.ssh\aliyun_admin_ed25519.pub`, press Enter, then press `Ctrl+D`.

Finish with:

```bash
chmod 600 ~/.ssh/authorized_keys
```

## Verify Passwordless Login

Run:

```powershell
ssh -F .\ALiYunFuWuQi\ssh_config aliyun-ubuntu exit
```

Success criteria:

- exit code is `0`
- no password prompt appears

## VS Code Remote-SSH

Do not change the shared workspace settings.

In your local VS Code user settings, point Remote-SSH at this config file:

```json
{
  "remote.SSH.configFile": "C:\\Users\\pengjianzhong\\Desktop\\老师项目\\WindSight\\ALiYunFuWuQi\\ssh_config"
}
```

Then connect to host:

- `aliyun-ubuntu`

## Troubleshooting

### `Permission denied (publickey,password)`

Check:

- the `admin` password is correct
- `%USERPROFILE%\.ssh\aliyun_admin_ed25519.pub` was appended to `~/.ssh/authorized_keys`
- remote permissions are correct:
  - `~/.ssh` is `700`
  - `~/.ssh/authorized_keys` is `600`

### Host key changed warning

Remove the stale host key entry and reconnect:

```powershell
ssh-keygen -R 101.200.135.73
```

### Password works but key does not

Inspect from Windows:

```powershell
ssh -vvv -F .\ALiYunFuWuQi\ssh_config aliyun-ubuntu exit
```

Look for whether `aliyun_admin_ed25519` is offered and whether the server accepts it.

## Current Scope

This setup is only for SSH access. It does not deploy WindSight, change server-side SSH hardening, or disable password authentication.
