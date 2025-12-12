"""
AI Service - Stream chat responses from AI models

Supports multiple AI providers:
- OpenAI (GPT-4, GPT-3.5)
- Anthropic (Claude)
- Local models via Ollama (optional)
"""

from typing import AsyncGenerator, List, Dict, Optional
import asyncio
import os
from loguru import logger


class AIService:
    """
    Service for streaming AI chat responses.

    Usage:
        ai = AIService(model="gpt-4-turbo-preview")
        async for chunk in ai.stream_chat(messages):
            print(chunk, end="")
    """

    def __init__(self, model: str = "gpt-4-turbo-preview"):
        """
        Initialize AI service.

        Args:
            model: Model identifier (gpt-4-turbo-preview, claude-3-opus, etc.)
        """
        self.model = model
        self.provider = self._detect_provider(model)

        logger.info(f"🤖 Initialized AI Service: {model} ({self.provider})")

    def _detect_provider(self, model: str) -> str:
        """Detect AI provider from model name"""
        if model.startswith("gpt"):
            return "openai"
        elif model.startswith("claude"):
            return "anthropic"
        else:
            return "ollama"

    async def stream_chat(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.7,
        max_tokens: int = 2000
    ) -> AsyncGenerator[str, None]:
        """
        Stream chat response from AI model.

        Args:
            messages: List of {"role": "user/assistant", "content": "..."}
            temperature: AI creativity (0.0-2.0)
            max_tokens: Maximum tokens to generate

        Yields:
            Text chunks as they are generated
        """
        try:
            if self.provider == "openai":
                async for chunk in self._stream_openai(messages, temperature, max_tokens):
                    yield chunk

            elif self.provider == "anthropic":
                async for chunk in self._stream_anthropic(messages, temperature, max_tokens):
                    yield chunk

            elif self.provider == "ollama":
                async for chunk in self._stream_ollama(messages, temperature, max_tokens):
                    yield chunk

            else:
                raise ValueError(f"Unknown provider: {self.provider}")

        except Exception as e:
            logger.exception(f"Error streaming from AI: {e}")
            yield f"\n\nError: {str(e)}"

    async def _stream_openai(
        self,
        messages: List[Dict],
        temperature: float,
        max_tokens: int
    ) -> AsyncGenerator[str, None]:
        """Stream from OpenAI API"""
        try:
            import openai

            # Check for API key
            api_key = os.getenv("OPENAI_API_KEY")
            if not api_key:
                # For demo, yield mock response
                logger.warning("⚠️  No OPENAI_API_KEY - using mock response")
                async for chunk in self._mock_stream(messages):
                    yield chunk
                return

            client = openai.AsyncOpenAI(api_key=api_key)

            stream = await client.chat.completions.create(
                model=self.model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                stream=True
            )

            async for chunk in stream:
                if chunk.choices[0].delta.content:
                    yield chunk.choices[0].delta.content

        except ImportError:
            logger.error("openai package not installed")
            async for chunk in self._mock_stream(messages):
                yield chunk
        except Exception as e:
            logger.exception(f"OpenAI error: {e}")
            yield f"\n\nError: {str(e)}"

    async def _stream_anthropic(
        self,
        messages: List[Dict],
        temperature: float,
        max_tokens: int
    ) -> AsyncGenerator[str, None]:
        """Stream from Anthropic API"""
        try:
            import anthropic

            api_key = os.getenv("ANTHROPIC_API_KEY")
            if not api_key:
                logger.warning("⚠️  No ANTHROPIC_API_KEY - using mock response")
                async for chunk in self._mock_stream(messages):
                    yield chunk
                return

            client = anthropic.AsyncAnthropic(api_key=api_key)

            # Convert messages format for Anthropic
            system = None
            claude_messages = []
            for msg in messages:
                if msg["role"] == "system":
                    system = msg["content"]
                else:
                    claude_messages.append(msg)

            async with client.messages.stream(
                model=self.model,
                messages=claude_messages,
                system=system,
                temperature=temperature,
                max_tokens=max_tokens
            ) as stream:
                async for text in stream.text_stream:
                    yield text

        except ImportError:
            logger.error("anthropic package not installed")
            async for chunk in self._mock_stream(messages):
                yield chunk
        except Exception as e:
            logger.exception(f"Anthropic error: {e}")
            yield f"\n\nError: {str(e)}"

    async def _stream_ollama(
        self,
        messages: List[Dict],
        temperature: float,
        max_tokens: int
    ) -> AsyncGenerator[str, None]:
        """Stream from local Ollama"""
        try:
            import httpx

            async with httpx.AsyncClient(timeout=60.0) as client:
                # Convert to Ollama format
                prompt = self._messages_to_prompt(messages)

                response = await client.post(
                    "http://localhost:11434/api/generate",
                    json={
                        "model": self.model,
                        "prompt": prompt,
                        "temperature": temperature,
                        "stream": True
                    },
                    timeout=60.0
                )

                async for line in response.aiter_lines():
                    if line:
                        import json
                        data = json.loads(line)
                        if "response" in data:
                            yield data["response"]

        except Exception as e:
            logger.exception(f"Ollama error: {e}")
            async for chunk in self._mock_stream(messages):
                yield chunk

    def _messages_to_prompt(self, messages: List[Dict]) -> str:
        """Convert messages to single prompt string"""
        prompt_parts = []
        for msg in messages:
            role = msg["role"]
            content = msg["content"]
            if role == "system":
                prompt_parts.append(f"System: {content}")
            elif role == "user":
                prompt_parts.append(f"User: {content}")
            elif role == "assistant":
                prompt_parts.append(f"Assistant: {content}")

        return "\n\n".join(prompt_parts) + "\n\nAssistant:"

    async def _mock_stream(self, messages: List[Dict]) -> AsyncGenerator[str, None]:
        """
        Mock streaming response for demo/testing.

        Generates realistic-looking Quebec electrical project data.
        """
        # Extract user's last message
        user_message = ""
        for msg in reversed(messages):
            if msg["role"] == "user":
                user_message = msg["content"].lower()
                break

        # Generate contextual response
        if any(word in user_message for word in ["projet", "korlcc", "alexis nihon", "urgence"]):
            response = """Voici un aperçu de vos projets électriques au Québec :

## 📊 Projets Actifs

### KORLCC
- **Budget**: 450 000 $
- **Dépensé**: 320 000 $ (71%)
- **État**: En cours
- **Main d'œuvre**: 45h cette semaine
- **Conformité**: CEQ ✓, RBQ ✓, RSST ✓

### Alexis Nihon
- **Budget**: 680 000 $
- **Dépensé**: 480 000 $ (70.6%)
- **État**: En cours
- **Main d'œuvre**: 52h cette semaine
- **Conformité**: CEQ ✓, RBQ ✓, CSA en révision

### Urgences
- **Budget**: 125 000 $
- **Dépensé**: 95 000 $ (76%)
- **État**: 🚨 URGENT
- **Main d'œuvre**: 28h cette semaine
- **Priorité**: Haute

## 💰 Rentabilité Globale
- Budget total: 1 255 000 $
- Dépensé: 895 000 $
- Marge: 28.69%

## 👷 Main d'œuvre (7 derniers jours)
- Total heures: 331h
- Coût moyen: 45 $/h
- 12 électriciens actifs

## ⚠️ Alertes
- Alexis Nihon: Budget à 70.6% utilisé
- Urgences: Intervention requise sous 48h
- Heures supplémentaires élevées cette semaine
"""
        elif any(word in user_message for word in ["matériel", "bom", "équipement"]):
            response = """## 📦 Matériel - Projet Électrique Québec

### Catégories Principales

**Câblage**
- Quantité: 2500m
- Coût: 12 500 $
- Certifications: CSA C22.2, UL

**Protection (Disjoncteurs)**
- Quantité: 45 unités
- Coût: 6 750 $
- Conformité: CEQ Section 14

**Panneaux Électriques**
- Quantité: 8 unités
- Coût: 24 000 $
- Type: 200A, 120/240V

**Conduits**
- Quantité: 450m
- Coût: 4 500 $
- Matériau: PVC et métal

**Éclairage**
- Quantité: 32 luminaires
- Coût: 9 600 $
- Efficacité: LED, certifié EnergyStar

### 💰 Total Matériel: 63 250 $
"""
        else:
            response = """Bonjour! Je suis l'assistant IA pour vos projets électriques au Québec.

Je peux vous aider avec:
- 📊 Tableaux de bord PGI (Projets, Rentabilité, Main d'œuvre)
- 📋 Génération de BOM (Bill of Materials)
- ✅ Vérification conformité CEQ, RBQ, RSST, CSA
- 📄 Analyse de plans électriques
- 📸 Géolocalisation de photos sur plans

Que puis-je faire pour vous?"""

        # Stream the response word by word
        words = response.split()
        for i, word in enumerate(words):
            yield word
            if i < len(words) - 1:
                yield " "
            await asyncio.sleep(0.02)  # Realistic typing speed
