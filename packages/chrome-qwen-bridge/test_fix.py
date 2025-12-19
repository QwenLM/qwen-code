#!/usr/bin/env python3

import json
import struct
import subprocess
import sys
import time

def send_message(proc, message):
    """Send a message to the Native Host"""
    encoded = json.dumps(message).encode('utf-8')
    proc.stdin.write(struct.pack('<I', len(encoded)))
    proc.stdin.write(encoded)
    proc.stdin.flush()

def read_message(proc):
    """Read a message from the Native Host"""
    raw_length = proc.stdout.read(4)
    if not raw_length:
        return None
    message_length = struct.unpack('<I', raw_length)[0]
    message = proc.stdout.read(message_length)
    return json.loads(message.decode('utf-8'))

def test_native_host():
    """Test the Native Host with various operations"""
    print("🔍 Testing Native Host after fix...")
    print()

    # Start the Native Host
    host_path = './native-host/run.sh'
    proc = subprocess.Popen(
        [host_path],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )

    try:
        # Test 1: Handshake
        print("1. Testing handshake...")
        send_message(proc, {"type": "handshake", "version": "1.0.0"})
        response = read_message(proc)
        print(f"   ✓ Handshake response: {response['type']}")
        print(f"   Qwen installed: {response.get('qwenInstalled', False)}")
        print()

        # Test 2: Get status (should not crash with null pid)
        print("2. Testing get_status...")
        send_message(proc, {"type": "get_status"})
        response = read_message(proc)
        if response and 'data' in response:
            print(f"   ✓ Status response received")
            print(f"   Qwen PID: {response['data'].get('qwenPid', 'None')}")
            print(f"   Qwen Status: {response['data'].get('qwenStatus', 'Unknown')}")
        else:
            print(f"   Response: {response}")
        print()

        # Test 3: Try to start Qwen (might fail if not installed)
        print("3. Testing start_qwen...")
        send_message(proc, {
            "type": "start_qwen",
            "config": {
                "httpPort": 8080,
                "mcpServers": []
            }
        })
        response = read_message(proc)
        if response:
            if response.get('success'):
                print(f"   ✓ Qwen started successfully")
                if response.get('data'):
                    print(f"   PID: {response['data'].get('pid', 'None')}")
            else:
                print(f"   ⚠ Qwen start failed: {response.get('error', 'Unknown error')}")
        print()

        print("✅ All tests completed without crashes!")

    except Exception as e:
        print(f"❌ Error during testing: {e}")
        import traceback
        traceback.print_exc()

    finally:
        proc.terminate()

if __name__ == "__main__":
    test_native_host()