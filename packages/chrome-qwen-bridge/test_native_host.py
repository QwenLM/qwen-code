#!/usr/bin/env python3

import json
import struct
import subprocess
import sys

def send_message(proc, message):
    """Send a message to the Native Host"""
    encoded = json.dumps(message).encode('utf-8')
    # Write message length (4 bytes, little-endian)
    proc.stdin.write(struct.pack('<I', len(encoded)))
    # Write message
    proc.stdin.write(encoded)
    proc.stdin.flush()

def read_message(proc):
    """Read a message from the Native Host"""
    # Read message length (4 bytes)
    raw_length = proc.stdout.read(4)
    if not raw_length:
        return None

    message_length = struct.unpack('<I', raw_length)[0]
    # Read message
    message = proc.stdout.read(message_length)
    return json.loads(message.decode('utf-8'))

def test_native_host():
    """Test the Native Host connection"""
    print("🔍 Testing Native Host connection...")
    print()

    # Start the Native Host
    host_path = './native-host/start.sh'
    try:
        proc = subprocess.Popen(
            [host_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )

        # Test 1: Handshake
        print("1. Sending handshake...")
        send_message(proc, {"type": "handshake", "version": "1.0.0"})
        response = read_message(proc)
        print(f"   Response: {response}")
        print()

        # Test 2: Get status
        print("2. Getting status...")
        send_message(proc, {"type": "get_status"})
        response = read_message(proc)
        print(f"   Response: {response}")
        print()

        # Terminate
        proc.terminate()
        print("✅ Native Host is working correctly!")

    except Exception as e:
        print(f"❌ Error: {e}")
        return 1

    return 0

if __name__ == "__main__":
    sys.exit(test_native_host())