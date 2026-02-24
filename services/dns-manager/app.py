#!/usr/bin/env python3
"""
DNS Manager Service for Traefik DNS-01 ACME Challenge
Manages DNS TXT records via Hostinger API
"""

import os
import time
import hashlib
import base64
from flask import Flask, request, jsonify
import requests

app = Flask(__name__)

HOSTINGER_API_KEY = os.getenv('HOSTINGER_API_KEY')
HOSTINGER_API_BASE = "https://developers.hostinger.com/api/dns/v1"
BASE_DOMAIN = "hill90.com"

def get_headers():
    return {
        "Authorization": f"Bearer {HOSTINGER_API_KEY}",
        "Content-Type": "application/json"
    }

def get_dns_records():
    """Get current DNS records for the domain"""
    url = f"{HOSTINGER_API_BASE}/zones/{BASE_DOMAIN}"
    response = requests.get(url, headers=get_headers())
    response.raise_for_status()
    return response.json()

def add_txt_record(record_name, value, ttl=300):
    """Add a TXT record via Hostinger API"""
    url = f"{HOSTINGER_API_BASE}/zones/{BASE_DOMAIN}"

    payload = {
        "zone": [{
            "name": record_name,
            "type": "TXT",
            "ttl": ttl,
            "records": [{"content": value}]
        }]
    }

    response = requests.put(url, headers=get_headers(), json=payload)
    response.raise_for_status()
    return response.json()

def delete_txt_record(record_name):
    """Delete TXT record by name"""
    # Hostinger API doesn't have a direct delete for individual records
    # We need to update with empty records or use the overwrite method
    url = f"{HOSTINGER_API_BASE}/zones/{BASE_DOMAIN}"

    payload = {
        "zone": [{
            "name": record_name,
            "type": "TXT",
            "ttl": 300,
            "records": []
        }],
        "overwrite": True
    }

    response = requests.put(url, headers=get_headers(), json=payload)
    response.raise_for_status()
    return response.json()

@app.route('/present', methods=['POST'])
def present():
    """
    Handle ACME DNS-01 challenge present request
    Creates _acme-challenge TXT record
    Supports both JSON body and query parameters (lego httpreq RAW mode)
    """
    try:
        # Log the raw request data for debugging
        print(f"[PRESENT] Content-Type: {request.content_type}", flush=True)
        print(f"[PRESENT] Headers: {dict(request.headers)}", flush=True)
        print(f"[PRESENT] Method: {request.method}", flush=True)
        print(f"[PRESENT] URL: {request.url}", flush=True)
        print(f"[PRESENT] JSON body: {request.get_json(silent=True)}", flush=True)
        print(f"[PRESENT] Query args: {dict(request.args)}", flush=True)
        print(f"[PRESENT] Form data: {dict(request.form)}", flush=True)
        print(f"[PRESENT] Raw data: {request.get_data(as_text=True)}", flush=True)

        # Try JSON body first, fall back to query parameters
        data = request.get_json(silent=True) or {}

        # Lego httpreq provider sends 'domain', 'token', and 'keyAuth'
        # For DNS-01 challenge, TXT value = base64url(SHA256(keyAuth))
        domain = data.get('domain') or data.get('fqdn')
        key_auth = data.get('keyAuth')

        # Compute the ACME DNS-01 challenge value
        if key_auth:
            # SHA256 hash of keyAuth, base64url encoded
            hash_digest = hashlib.sha256(key_auth.encode()).digest()
            value = base64.urlsafe_b64encode(hash_digest).decode().rstrip('=')
        else:
            # Fallback to token or value if keyAuth not provided
            value = data.get('token') or data.get('value')

        # If JSON didn't provide values, try query parameters or form data
        if not domain:
            domain = request.args.get('domain') or request.args.get('fqdn') or request.form.get('domain') or request.form.get('fqdn')
        if not value:
            value = request.args.get('token') or request.args.get('value') or request.form.get('token') or request.form.get('value')

        # Construct FQDN: _acme-challenge.DOMAIN
        if domain and not domain.startswith('_acme-challenge'):
            fqdn = f"_acme-challenge.{domain}"
        else:
            fqdn = domain

        if not fqdn or not value:
            app.logger.error(f"Missing parameters - JSON: {request.is_json}, Args: {dict(request.args)}, Form: {dict(request.form)}")
            return jsonify({"error": "Missing fqdn or value"}), 400

        # Extract record name (e.g., _acme-challenge.portainer)
        if fqdn.endswith(f".{BASE_DOMAIN}"):
            record_name = fqdn[:-len(f".{BASE_DOMAIN}")]
        else:
            return jsonify({"error": f"Invalid domain: {fqdn}"}), 400

        app.logger.info(f"Adding TXT record: {record_name} = {value}")
        result = add_txt_record(record_name, value)

        # Return immediately - Traefik waits for DNS propagation (delayBeforeCheck: 30s)
        app.logger.info(f"TXT record added successfully: {record_name}")

        return jsonify({"status": "success", "result": result}), 200

    except Exception as e:
        app.logger.error(f"Error adding TXT record: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/cleanup', methods=['POST'])
def cleanup():
    """
    Handle ACME DNS-01 challenge cleanup request
    Removes _acme-challenge TXT record
    Supports both JSON body and query parameters (lego httpreq RAW mode)
    """
    try:
        # Try JSON body first, fall back to query parameters
        data = request.get_json(silent=True) or {}

        # Lego httpreq provider sends 'domain' (not 'fqdn')
        domain = data.get('domain') or data.get('fqdn')

        # If JSON didn't provide domain, try query parameters or form data
        if not domain:
            domain = request.args.get('domain') or request.args.get('fqdn') or request.form.get('domain') or request.form.get('fqdn')

        # Construct FQDN: _acme-challenge.DOMAIN
        if domain and not domain.startswith('_acme-challenge'):
            fqdn = f"_acme-challenge.{domain}"
        else:
            fqdn = domain

        if not fqdn:
            app.logger.error(f"Missing fqdn - JSON: {request.is_json}, Args: {dict(request.args)}, Form: {dict(request.form)}")
            return jsonify({"error": "Missing fqdn"}), 400

        # Extract record name
        if fqdn.endswith(f".{BASE_DOMAIN}"):
            record_name = fqdn[:-len(f".{BASE_DOMAIN}")]
        else:
            return jsonify({"error": f"Invalid domain: {fqdn}"}), 400

        app.logger.info(f"Deleting TXT record: {record_name}")
        result = delete_txt_record(record_name)

        return jsonify({"status": "success", "result": result}), 200

    except Exception as e:
        app.logger.error(f"Error deleting TXT record: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({"status": "healthy"}), 200

if __name__ == '__main__':
    if not HOSTINGER_API_KEY:
        raise ValueError("HOSTINGER_API_KEY environment variable is required")

    app.run(host='0.0.0.0', port=8080, debug=False)
