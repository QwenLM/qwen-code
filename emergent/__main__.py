import argparse
import json
from emergent.core import generate_world_blueprint

def main():
    """The main entry point for the Emergent Worlds CLI."""
    parser = argparse.ArgumentParser(
        prog="emergent",
        description="Generate a World Blueprint from a high-level prompt."
    )
    parser.add_argument(
        "prompt",
        type=str,
        help="The high-level text prompt for world generation."
    )
    parser.add_argument(
        "-o", "--output",
        type=str,
        help="The path to the file where the World Blueprint will be saved."
    )

    args = parser.parse_args()

    # Generate the blueprint by calling the core logic
    world_blueprint = generate_world_blueprint(args.prompt)

    # Output the blueprint
    if args.output:
        with open(args.output, 'w') as f:
            json.dump(world_blueprint, f, indent=4)
        print(f"World Blueprint saved to {args.output}")
    else:
        print(json.dumps(world_blueprint, indent=4))

if __name__ == "__main__":
    main()
