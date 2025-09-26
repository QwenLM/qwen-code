import heapq
from typing import List


def k_way_merge(arrays: List[List[int]]) -> List[int]:
    """
    Merges k sorted arrays using a min-heap.
    
    Args:
        arrays: List of k sorted arrays
        
    Returns:
        Single merged sorted array
    """
    # Min-heap to keep track of smallest elements from each array
    heap = []
    result = []
    
    # Initialize heap with first element from each non-empty array
    for i, arr in enumerate(arrays):
        if arr:  # Only add if array is not empty
            heapq.heappush(heap, (arr[0], i, 0))  # (value, array_index, element_index)
    
    # Process until heap is empty
    while heap:
        # Get smallest element
        value, array_idx, element_idx = heapq.heappop(heap)
        result.append(value)
        
        # If there are more elements in the same array, add next element to heap
        if element_idx + 1 < len(arrays[array_idx]):
            next_element = arrays[array_idx][element_idx + 1]
            heapq.heappush(heap, (next_element, array_idx, element_idx + 1))
    
    return result


# Example usage
if __name__ == "__main__":
    # Example with 3 sorted arrays
    sorted_arrays = [
        [1, 5, 9, 13],
        [2, 6, 10, 14],
        [3, 7, 11, 15]
    ]
    
    print("Input arrays:")
    for i, arr in enumerate(sorted_arrays):
        print(f"Array {i + 1}: {arr}")
    
    result = k_way_merge(sorted_arrays)
    print(f"\nMerged result: {result}")
    
    # Another example with different sized arrays
    sorted_arrays2 = [
        [1, 4, 7],
        [2, 5],
        [3, 6, 8, 9]
    ]
    
    print(f"\nAnother example:")
    print("Input arrays:")
    for i, arr in enumerate(sorted_arrays2):
        print(f"Array {i + 1}: {arr}")
    
    result2 = k_way_merge(sorted_arrays2)
    print(f"Merged result: {result2}")