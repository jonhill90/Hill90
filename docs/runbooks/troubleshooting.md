# Troubleshooting Guide

Common issues and solutions.

## VPS Access Issues

**Problem**: Cannot SSH to VPS

**Solutions**:
- Check Tailscale connection: `tailscale status`
- Verify VPS IP in inventory
- Check SSH key permissions: `chmod 600 ~/.ssh/id_ed25519`

## Service Not Starting

**Problem**: Service fails to start

**Solutions**:
- Check logs: `make logs-<service>`
- Verify environment variables
- Check Docker status: `docker ps`
- Review compose file

## TLS Certificate Issues

**Problem**: Let's Encrypt certificate not issued

**Solutions**:
- Verify DNS records point to VPS
- Check Traefik logs: `make logs-traefik`
- Ensure ports 80/443 are open
- Wait 10 minutes for DNS propagation

## Database Connection Issues

**Problem**: Services can't connect to PostgreSQL

**Solutions**:
- Check PostgreSQL is running: `docker ps | grep postgres`
- Verify credentials in secrets
- Check internal network connectivity
- Review database logs

## For More Help

- Check service logs
- Review configuration files
- Consult [Architecture](../architecture/overview.md)
