"""
Hill90 AI Service
Python/FastAPI with LangChain/LangGraph
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(
    title="Hill90 AI Service",
    version="0.1.0",
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://hill90.com", "https://api.hill90.com"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "service": "ai"}


@app.get("/")
async def root():
    """Root endpoint."""
    return {"message": "Hill90 AI Service"}
