#!/usr/bin/env python3
"""
DNS Manager Service for Traefik DNS-01 ACME Challenge
Manages DNS TXT records via Hostinger API
"""

import os
import time
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
    """
    try:
        data = request.json
        fqdn = data.get('fqdn')  # e.g., _acme-challenge.portainer.hill90.com
        value = data.get('value')  # TXT record value

        if not fqdn or not value:
            return jsonify({"error": "Missing fqdn or value"}), 400

        # Extract record name (e.g., _acme-challenge.portainer)
        if fqdn.endswith(f".{BASE_DOMAIN}"):
            record_name = fqdn[:-len(f".{BASE_DOMAIN}")]
        else:
            return jsonify({"error": f"Invalid domain: {fqdn}"}), 400

        app.logger.info(f"Adding TXT record: {record_name} = {value}")
        result = add_txt_record(record_name, value)

        # Wait for DNS propagation
        app.logger.info("Waiting 30 seconds for DNS propagation...")
        time.sleep(30)

        return jsonify({"status": "success", "result": result}), 200

    except Exception as e:
        app.logger.error(f"Error adding TXT record: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/cleanup', methods=['POST'])
def cleanup():
    """
    Handle ACME DNS-01 challenge cleanup request
    Removes _acme-challenge TXT record
    """
    try:
        data = request.json
        fqdn = data.get('fqdn')

        if not fqdn:
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
