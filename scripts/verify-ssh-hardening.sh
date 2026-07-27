#!/usr/bin/env bash
# Verify SSH hardening against the EFFECTIVE sshd configuration.
#
# Run on the host:            sudo bash scripts/verify-ssh-hardening.sh
# Or over SSH, read-only:     ssh deploy@<host> 'sudo bash /opt/hill90/app/scripts/verify-ssh-hardening.sh'
#
# WHY THIS EXISTS
#
# The hardening role used to write PasswordAuthentication no into
# /etc/ssh/sshd_config, where it never took effect: the stock config includes
# /etc/ssh/sshd_config.d/*.conf near the top, sshd takes the FIRST value it sees
# for a keyword, and the cloud-init drop-in in that directory sets the opposite.
# The role ran, reported success, and changed nothing — through a full rebuild.
#
# Reading the file it wrote would not have caught that. Only `sshd -T`, the
# effective post-include configuration, shows what the daemon will actually do.
# This script exists so the claim is checkable without running a deploy.
#
# It is read-only: it inspects configuration and changes nothing.

set -uo pipefail

SSHD_BIN="${SSHD_BIN:-/usr/sbin/sshd}"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'

fail_count=0

if [ ! -x "$SSHD_BIN" ]; then
    echo "${RED}ERROR${NC}: $SSHD_BIN not found or not executable."
    echo "  This must run on the SSH host, as root (sshd -T needs privilege)."
    exit 2
fi

if ! effective=$("$SSHD_BIN" -T 2>/dev/null); then
    echo "${RED}ERROR${NC}: '$SSHD_BIN -T' failed."
    echo "  Run as root. If it fails as root, the sshd configuration is invalid:"
    echo "    sudo $SSHD_BIN -t"
    exit 2
fi

echo "================================"
echo "SSH Hardening Verification"
echo "================================"
echo ""
echo "Checking the EFFECTIVE configuration ($SSHD_BIN -T), not the files."
echo ""

# keyword -> required value
check() {
    local key="$1" want="$2" got
    got=$(printf '%s\n' "$effective" | awk -v k="$key" '$1==k {print $2; exit}')
    printf '  %-32s ' "$key"
    if [ -z "$got" ]; then
        echo "${YELLOW}not set${NC} (expected $want)"
        fail_count=$((fail_count + 1))
    elif [ "$got" = "$want" ]; then
        echo "${GREEN}$got${NC}"
    else
        echo "${RED}$got${NC}  ← expected $want"
        fail_count=$((fail_count + 1))
    fi
}

check passwordauthentication      no
check permitrootlogin             no
check pubkeyauthentication        yes
check kbdinteractiveauthentication no
check permitemptypasswords        no
check maxauthtries                3

echo ""

if [ "$fail_count" -eq 0 ]; then
    echo "${GREEN}✓ SSH hardening verified.${NC}"
    exit 0
fi

echo "${RED}✗ ${fail_count} setting(s) do not match the intended hardening.${NC}"
echo ""
echo "The daemon disagrees with what the role wrote, which means another file"
echo "wins. sshd takes the FIRST value it sees, and drop-ins are read in lexical"
echo "order at the point of the Include directive. Find the file that wins:"
echo ""
echo "    grep -nE '^\\s*Include' /etc/ssh/sshd_config"
echo "    ls -1 /etc/ssh/sshd_config.d/"
echo "    grep -rniE '^\\s*(PasswordAuthentication|PermitRootLogin)' /etc/ssh/"
echo ""
echo "The hardening drop-in should be /etc/ssh/sshd_config.d/00-hill90-hardening.conf,"
echo "named 00- so it sorts before 50-cloud-init.conf. Re-apply it with:"
echo ""
echo "    make config-vps"
echo ""
exit 1
