FROM python:3.12-slim

WORKDIR /app

# Install dependencies
RUN pip install --no-cache-dir flask requests

# Copy application
COPY app.py /app/

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD python -c "import requests; requests.get('http://localhost:8080/health')"

# Run as non-root
RUN useradd -m -u 1000 dnsmanager && chown -R dnsmanager:dnsmanager /app
USER dnsmanager

EXPOSE 8080

CMD ["python", "app.py"]
