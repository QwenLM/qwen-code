"""
Streaming API endpoint for AI chat with Server-Sent Events (SSE).
Supports streaming responses with PGI data detection.
"""

from fastapi import APIRouter, HTTPException, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional, AsyncGenerator
import json
import asyncio
from loguru import logger

from services.pgi_detector import PGIDetector, PGIData
from services.ai_service import AIService

stream_router = APIRouter()


class Message(BaseModel):
    """Chat message model"""
    role: str = Field(..., description="Role: 'user' or 'assistant'")
    content: str = Field(..., description="Message content")


class StreamRequest(BaseModel):
    """Request model for streaming endpoint"""
    messages: List[Message] = Field(..., description="Conversation history")
    temperature: float = Field(default=0.7, ge=0.0, le=2.0, description="AI temperature")
    max_tokens: int = Field(default=2000, ge=1, le=4000, description="Maximum tokens")
    detect_pgi: bool = Field(default=True, description="Enable PGI data detection")
    model: str = Field(default="gpt-4-turbo-preview", description="AI model to use")


def get_pgi_detector(request: Request) -> PGIDetector:
    """Dependency to get PGI detector from app state"""
    return request.app.state.pgi_detector


async def generate_ai_stream(
    messages: List[Message],
    temperature: float,
    max_tokens: int,
    detect_pgi: bool,
    model: str,
    pgi_detector: PGIDetector
) -> AsyncGenerator[str, None]:
    """
    Generate streaming AI response with optional PGI data detection.

    Args:
        messages: Conversation history
        temperature: AI temperature parameter
        max_tokens: Maximum tokens to generate
        detect_pgi: Whether to detect and format PGI data
        model: AI model identifier
        pgi_detector: PGI detector service

    Yields:
        str: Server-Sent Event formatted data
    """
    try:
        # Initialize AI service
        ai_service = AIService(model=model)

        # Accumulate response for PGI detection
        full_response = ""
        pgi_data_detected = False

        # Stream AI response
        async for chunk in ai_service.stream_chat(
            messages=[{"role": m.role, "content": m.content} for m in messages],
            temperature=temperature,
            max_tokens=max_tokens
        ):
            full_response += chunk

            # Send text chunk
            yield f"data: {json.dumps({'type': 'text', 'content': chunk})}\n\n"

            # Detect PGI data if enabled and we have enough content
            if detect_pgi and not pgi_data_detected and len(full_response) > 100:
                pgi_data = pgi_detector.detect_and_format(full_response)
                if pgi_data:
                    pgi_data_detected = True
                    logger.info(f"📊 PGI data detected: {pgi_data.type}")

                    # Send PGI artifact
                    yield f"data: {json.dumps({'type': 'pgi', 'data': pgi_data.model_dump()})}\n\n"

            # Small delay to prevent overwhelming client
            await asyncio.sleep(0.01)

        # Final PGI detection if not already detected
        if detect_pgi and not pgi_data_detected:
            pgi_data = pgi_detector.detect_and_format(full_response)
            if pgi_data:
                logger.info(f"📊 PGI data detected at end: {pgi_data.type}")
                yield f"data: {json.dumps({'type': 'pgi', 'data': pgi_data.model_dump()})}\n\n"

        # Send completion signal
        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    except Exception as e:
        logger.exception(f"Error in AI streaming: {e}")
        yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"


@stream_router.post("/stream")
async def stream_chat(
    request: StreamRequest,
    pgi_detector: PGIDetector = Depends(get_pgi_detector)
):
    """
    Stream AI chat responses with Server-Sent Events.

    Supports real-time AI responses and automatic PGI dashboard data detection.

    Request body:
        - messages: List of conversation messages
        - temperature: AI creativity (0.0-2.0)
        - max_tokens: Maximum response length
        - detect_pgi: Enable PGI data detection
        - model: AI model to use

    Response:
        Server-Sent Events stream with:
        - type: 'text' - Text chunk
        - type: 'pgi' - PGI dashboard data
        - type: 'done' - Stream completed
        - type: 'error' - Error occurred

    Example:
        ```python
        # Client-side EventSource
        const eventSource = new EventSource('/api/stream');
        eventSource.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'text') console.log(data.content);
            if (data.type === 'pgi') renderPGIDashboard(data.data);
        };
        ```
    """
    try:
        logger.info(f"📡 Starting stream for {len(request.messages)} messages")

        return StreamingResponse(
            generate_ai_stream(
                messages=request.messages,
                temperature=request.temperature,
                max_tokens=request.max_tokens,
                detect_pgi=request.detect_pgi,
                model=request.model,
                pgi_detector=pgi_detector
            ),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no"  # Disable buffering for nginx
            }
        )

    except Exception as e:
        logger.exception(f"Error setting up stream: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@stream_router.get("/stream/test")
async def test_stream():
    """
    Test endpoint to verify SSE streaming works.

    Returns a simple countdown stream for testing.
    """
    async def test_generator():
        for i in range(5, 0, -1):
            yield f"data: {json.dumps({'count': i, 'message': f'Test {i}'})}\n\n"
            await asyncio.sleep(1)
        yield f"data: {json.dumps({'done': True})}\n\n"

    return StreamingResponse(
        test_generator(),
        media_type="text/event-stream"
    )
