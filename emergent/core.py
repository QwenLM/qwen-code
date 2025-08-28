"""
The core generation engine for Emergent Worlds.
"""

def _mock_generative_ai_call(system_prompt: str, user_prompt: str) -> dict:
    """
    A mock function to simulate a call to a generative AI model.
    It returns a pre-defined dictionary based on keywords in the user_prompt.
    """
    # This function is a stand-in for a real call to a model like qwen-code.
    # The system_prompt is included for future compatibility.
    user_prompt = user_prompt.lower()
    if "cloud" in user_prompt or "sky" in user_prompt:
        return {
            "style": "ethereal, art nouveau",
            "primary_material": "spun cloud-matter",
            "secondary_material": "brass fittings",
            "key_feature": "translucent, light-filtering walkways"
        }
    elif "forest" in user_prompt or "tree" in user_prompt:
        return {
            "style": "naturalistic, integrated",
            "primary_material": "living wood",
            "secondary_material": "moss and river stone",
            "key_feature": "structures are grown, not built"
        }
    elif "underwater" in user_prompt or "ocean" in user_prompt:
        return {
            "style": "bioluminescent, organic",
            "primary_material": "biocrete from coral",
            "secondary_material": "hardened kelp",
            "key_feature": "buildings pulse with soft, internal light"
        }
    else:
        return {
            "style": "generic modern",
            "primary_material": "concrete",
            "secondary_material": "steel and glass",
            "key_feature": "functional but uninspired design"
        }

def generate_mycomind(prompt: str) -> dict:
    """Placeholder for the MycoMind systems modeler."""
    return {
        "system_name": "MycoMind",
        "description": "Models the social and economic systems of the world.",
        "prompt_received": prompt,
        "data": { "agents": 100, "initial_resource": "water" }
    }

def generate_architectonic(prompt: str) -> dict:
    """Generates architectural data by calling the mock AI."""
    system_prompt = (
        "You are an imaginative architectural designer. "
        "Based on the user's prompt, describe a unique architectural style. "
        "Provide a style, a primary material, a secondary material, and a key feature."
    )

    ai_generated_data = _mock_generative_ai_call(system_prompt, prompt)

    return {
        "system_name": "Architectonic",
        "description": "Generates the physical architecture and layout.",
        "prompt_received": prompt,
        "data": ai_generated_data
    }

def generate_lexisynth(prompt: str) -> dict:
    """Placeholder for the LexiSynth legal/social contract synthesizer."""
    return {
        "system_name": "LexiSynth",
        "description": "Defines the laws, traditions, and social contracts.",
        "prompt_received": prompt,
        "data": { "legal_system": "common_law", "core_tenet": "harmony" }
    }

def generate_gastronomicon(prompt: str) -> dict:
    """Placeholder for the Gastronomicon culinary creator."""
    return {
        "system_name": "Gastronomicon",
        "description": "Creates the cuisine based on the world's ecosystem.",
        "prompt_received": prompt,
        "data": { "staple_food": "native fungus", "key_spice": "red salt" }
    }

def generate_choreograph(prompt: str) -> dict:
    """Placeholder for the Choreograph movement sequencer."""
    return {
        "system_name": "Choreograph",
        "description": "Designs the rituals, dances, and common movements.",
        "prompt_received": prompt,
        "data": { "primary_ritual": "sun-gazing", "movement_style": "slow" }
    }

def generate_world_blueprint(prompt: str) -> dict:
    """
    Assembles the complete World Blueprint by calling all core generative systems.
    """
    blueprint = {
        "meta": {
            "source_prompt": prompt,
            "version": "0.1.0"
        },
        "systems": {
            "mycomind": generate_mycomind(prompt),
            "architectonic": generate_architectonic(prompt),
            "lexisynth": generate_lexisynth(prompt),
            "gastronomicon": generate_gastronomicon(prompt),
            "choreograph": generate_choreograph(prompt),
        }
    }
    return blueprint
