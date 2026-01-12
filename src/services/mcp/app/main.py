"""
Hill90 MCP Gateway
Python/FastAPI with MCP SDK
"""

from fastapi import FastAPI

app = FastAPI(title="Hill90 MCP Gateway", version="0.1.0")


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "service": "mcp"}
