#!/usr/bin/env python3
"""Script to generate 2000 lines of text."""

import random

WORDS = [
    "the", "be", "to", "of", "and", "a", "in", "that", "have", "I",
    "it", "for", "not", "on", "with", "he", "as", "you", "do", "at",
    "this", "but", "his", "by", "from", "they", "we", "say", "her", "she",
    "or", "an", "will", "my", "one", "all", "would", "there", "their", "what",
    "so", "up", "out", "if", "about", "who", "get", "which", "go", "me",
    "when", "make", "can", "like", "time", "no", "just", "him", "know", "take",
    "people", "into", "year", "your", "good", "some", "could", "them", "see", "other",
    "than", "then", "now", "look", "only", "come", "its", "over", "think", "also",
    "back", "after", "use", "two", "how", "our", "work", "first", "well", "way",
    "even", "new", "want", "because", "any", "these", "give", "day", "most", "us",
    "code", "data", "file", "system", "process", "run", "test", "build", "deploy", "server",
    "client", "request", "response", "error", "log", "config", "input", "output", "value", "type",
    "function", "method", "class", "object", "variable", "constant", "loop", "condition", "return", "import",
    "export", "module", "package", "library", "framework", "api", "database", "query", "cache", "memory",
]


def generate_random_line(word_count=10):
    """Generate a random line of text with meaningful words."""
    return " ".join(random.choice(WORDS) for _ in range(word_count))


def main():
    num_lines = 2000

    for i in range(1, num_lines + 1):
        line = f"Line {i:04d}: {generate_random_line(60)}"
        print(line)


if __name__ == "__main__":
    main()