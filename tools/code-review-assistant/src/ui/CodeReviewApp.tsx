import React, { useState, useEffect } from 'react';
import { Box, Text, Newline } from 'ink';
import SelectInput from 'ink-select-input';
import { CodeReviewCLI, ReviewResult, ReviewOptions } from '../cli/CodeReviewCLI.js';
import { Config } from '@qwen-code/qwen-code-core';

interface CodeReviewAppProps {
  config: Config;
  options: ReviewOptions;
}

interface MenuOption {
  label: string;
  value: string;
}

export const CodeReviewApp: React.FC<CodeReviewAppProps> = ({ config, options }) => {
  const [selectedOption, setSelectedOption] = useState<string>('');
  const [isReviewing, setIsReviewing] = useState(false);
  const [reviewResult, setReviewResult] = useState<ReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const menuOptions: MenuOption[] = [
    { label: '🔍 Review current repository changes', value: 'review' },
    { label: '📝 Review specific diff', value: 'diff' },
    { label: '🔗 Review pull request', value: 'pr' },
    { label: '⚙️  Configure review settings', value: 'config' },
    { label: '❌ Exit', value: 'exit' }
  ];

  const handleSelect = async (option: MenuOption) => {
    if (option.value === 'exit') {
      process.exit(0);
    }

    if (option.value === 'review') {
      await performReview();
    } else {
      setSelectedOption(option.value);
    }
  };

  const performReview = async () => {
    try {
      setIsReviewing(true);
      setError(null);
      
      const cli = new CodeReviewCLI(config);
      // For GUI, we'll simulate the review process
      // In a real implementation, you'd want to capture the output
      await cli.review(options);
      
      // Simulate result for demo
      setReviewResult({
        summary: 'Code review completed successfully',
        issues: [
          {
            severity: 'medium',
            category: 'Code Style',
            description: 'Inconsistent indentation in function',
            suggestion: 'Use consistent 2-space indentation'
          }
        ],
        suggestions: [
          'Add error handling for edge cases',
          'Consider adding input validation'
        ],
        score: 8
      });
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error occurred');
    } finally {
      setIsReviewing(false);
    }
  };

  if (isReviewing) {
    return (
      <Box flexDirection="column" alignItems="center">
        <Text color="blue">🔍 Performing code review...</Text>
        <Text color="gray">This may take a few moments...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" alignItems="center">
        <Text color="red">❌ Error: {error}</Text>
        <Newline />
        <Text color="gray">Press any key to continue...</Text>
      </Box>
    );
  }

  if (reviewResult) {
    return (
      <Box flexDirection="column">
        <Text color="blue" bold>📋 Code Review Results</Text>
        <Text color="green">{'='.repeat(50)}</Text>
        <Newline />
        
        <Text color="cyan">📝 Summary:</Text>
        <Text>{reviewResult.summary}</Text>
        <Newline />
        
        <Text color="cyan">🎯 Overall Score:</Text>
        <Text color="yellow">{reviewResult.score}/10</Text>
        <Newline />
        
        {reviewResult.issues.length > 0 && (
          <>
            <Text color="red">⚠️  Issues Found:</Text>
            {reviewResult.issues.map((issue, index) => (
              <Box key={index} flexDirection="column" marginLeft={2}>
                <Text>
                  {index + 1}. [{issue.severity.toUpperCase()}] {issue.category}
                </Text>
                <Text marginLeft={2}>{issue.description}</Text>
                {issue.suggestion && (
                  <Text marginLeft={2} color="blue">
                    💡 Suggestion: {issue.suggestion}
                  </Text>
                )}
                <Newline />
              </Box>
            ))}
          </>
        )}
        
        {reviewResult.suggestions.length > 0 && (
          <>
            <Text color="blue">💡 Suggestions:</Text>
            {reviewResult.suggestions.map((suggestion, index) => (
              <Text key={index} marginLeft={2}>
                {index + 1}. {suggestion}
              </Text>
            ))}
          </>
        )}
        
        <Newline />
        <Text color="gray">Press any key to return to menu...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" alignItems="center">
      <Text color="blue" bold>🔍 Code Review Assistant</Text>
      <Text color="gray">AI-powered code review using Qwen Code</Text>
      <Newline />
      
      <Text color="cyan">Select an option:</Text>
      <Newline />
      
      <SelectInput
        items={menuOptions}
        onSelect={handleSelect}
        indicatorComponent={({ isSelected }) => (
          <Text color={isSelected ? 'green' : 'white'}>
            {isSelected ? '❯' : ' '}
          </Text>
        )}
        itemComponent={({ isSelected, label }) => (
          <Text color={isSelected ? 'green' : 'white'}>
            {label}
          </Text>
        )}
      />
      
      <Newline />
      <Text color="gray">Use ↑↓ to navigate, Enter to select</Text>
    </Box>
  );
};