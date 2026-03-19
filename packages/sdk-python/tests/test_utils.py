"""Tests for utility functions."""

import pytest
import asyncio

from qwen_code.utils import Stream, serialize_json_line, deserialize_json_line


class TestStream:
    """Tests for Stream class."""

    def test_initial_state(self) -> None:
        """Test stream initial state."""
        stream = Stream()
        assert stream.has_error is None
        assert stream._done is False
        assert stream._queue.qsize() == 0

    def test_enqueue(self) -> None:
        """Test adding items to the stream."""
        stream = Stream()
        stream.enqueue("test")
        assert stream._queue.qsize() == 1

    def test_enqueue_multiple(self) -> None:
        """Test adding multiple items to the stream."""
        stream = Stream()
        stream.enqueue("item1")
        stream.enqueue("item2")
        stream.enqueue("item3")
        assert stream._queue.qsize() == 3

    def test_error(self) -> None:
        """Test setting error on stream."""
        stream = Stream()
        error = ValueError("test error")
        stream.error(error)
        assert stream.has_error is True
        assert stream._error is error

    def test_done(self) -> None:
        """Test marking stream as done."""
        stream = Stream()
        stream.done()
        assert stream._done is True

    def test_repr(self) -> None:
        """Test __repr__ method."""
        stream = Stream()
        stream.enqueue("test")
        repr_str = repr(stream)
        assert "Stream" in repr_str
        assert "queue_size=1" in repr_str

    def test_enqueue_after_done_raises(self) -> None:
        """Test that enqueue after done raises."""
        stream = Stream()
        stream.done()
        with pytest.raises(RuntimeError):
            stream.enqueue("test")

    def test_enqueue_after_error_raises(self) -> None:
        """Test that enqueue after error raises."""
        stream = Stream()
        stream.error(ValueError("test"))
        with pytest.raises(RuntimeError):
            stream.enqueue("test")

    @pytest.mark.asyncio
    async def test_async_iteration(self) -> None:
        """Test async iteration of stream."""
        stream = Stream()
        stream.enqueue("item1")
        stream.enqueue("item2")
        stream.done()

        items = []
        async for item in stream:
            items.append(item)

        assert items == ["item1", "item2"]

    @pytest.mark.asyncio
    async def test_async_iteration_with_error(self) -> None:
        """Test async iteration raises error."""
        stream = Stream()
        stream.error(ValueError("test error"))
        stream.done()

        with pytest.raises(ValueError, match="test error"):
            async for item in stream:
                pass


class TestSerializeJsonLine:
    """Tests for serialize_json_line function."""

    def test_serialize_dict(self) -> None:
        """Test serializing a dictionary."""
        obj = {"key": "value", "number": 123}
        result = serialize_json_line(obj)
        # Should be valid JSON followed by newline
        assert result.endswith("\n")
        assert result.count("\n") == 1

    def test_serialize_list(self) -> None:
        """Test serializing a list."""
        obj = [1, 2, 3, "test"]
        result = serialize_json_line(obj)
        assert result.endswith("\n")

    def test_serialize_string(self) -> None:
        """Test serializing a string."""
        obj = "test string"
        result = serialize_json_line(obj)
        assert result == '"test string"\n'

    def test_serialize_number(self) -> None:
        """Test serializing a number."""
        obj = 42
        result = serialize_json_line(obj)
        assert result == "42\n"

    def test_serialize_boolean(self) -> None:
        """Test serializing a boolean."""
        result = serialize_json_line(True)
        assert result == "true\n"

    def test_serialize_null(self) -> None:
        """Test serializing null."""
        result = serialize_json_line(None)
        assert result == "null\n"

    def test_serialize_nested(self) -> None:
        """Test serializing nested objects."""
        obj = {"outer": {"inner": [1, 2, 3]}}
        result = serialize_json_line(obj)
        assert result.endswith("\n")
        # Verify it's valid JSON
        import json
        parsed = json.loads(result.strip())
        assert parsed == obj


class TestDeserializeJsonLine:
    """Tests for deserialize_json_line function."""

    def test_deserialize_dict(self) -> None:
        """Test deserializing a dictionary."""
        line = '{"key": "value"}\n'
        result = deserialize_json_line(line)
        assert result == {"key": "value"}

    def test_deserialize_list(self) -> None:
        """Test deserializing a list."""
        line = '[1, 2, 3]\n'
        result = deserialize_json_line(line)
        assert result == [1, 2, 3]

    def test_deserialize_string(self) -> None:
        """Test deserializing a string."""
        line = '"test string"\n'
        result = deserialize_json_line(line)
        assert result == "test string"

    def test_deserialize_number(self) -> None:
        """Test deserializing a number."""
        line = "42\n"
        result = deserialize_json_line(line)
        assert result == 42

    def test_roundtrip(self) -> None:
        """Test serialize/deserialize roundtrip."""
        original = {"key": "value", "nested": {"inner": [1, 2, 3]}}
        serialized = serialize_json_line(original)
        deserialized = deserialize_json_line(serialized)
        assert deserialized == original
