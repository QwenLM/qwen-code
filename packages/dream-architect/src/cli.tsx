import React, { useState } from 'react';
import { Box, Text, Newline } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';

interface DreamSession {
  description: string;
  emotions: string[];
  symbols: string[];
  colors: string[];
  actions: string[];
}

export const DreamArchitectCLI: React.FC = () => {
  const [step, setStep] = useState<'welcome' | 'description' | 'emotions' | 'symbols' | 'colors' | 'actions' | 'processing' | 'result'>('welcome');
  const [dreamData, setDreamData] = useState<DreamSession>({
    description: '',
    emotions: [],
    symbols: [],
    colors: [],
    actions: []
  });
  const [currentInput, setCurrentInput] = useState('');
  const [result, setResult] = useState('');

  const emotionOptions = [
    { label: 'Joy', value: 'joy' },
    { label: 'Fear', value: 'fear' },
    { label: 'Wonder', value: 'wonder' },
    { label: 'Confusion', value: 'confusion' },
    { label: 'Peace', value: 'peace' },
    { label: 'Excitement', value: 'excitement' },
    { label: 'Mystery', value: 'mystery' }
  ];

  const symbolOptions = [
    { label: 'Flying', value: 'flying' },
    { label: 'Water', value: 'water' },
    { label: 'Forest', value: 'forest' },
    { label: 'Buildings', value: 'buildings' },
    { label: 'Animals', value: 'animals' },
    { label: 'Machines', value: 'machines' },
    { label: 'Light', value: 'light' },
    { label: 'Shadows', value: 'shadows' }
  ];

  const colorOptions = [
    { label: 'Blue', value: 'blue' },
    { label: 'Red', value: 'red' },
    { label: 'Green', value: 'green' },
    { label: 'Purple', value: 'purple' },
    { label: 'Gold', value: 'gold' },
    { label: 'Silver', value: 'silver' },
    { label: 'Black', value: 'black' },
    { label: 'White', value: 'white' }
  ];

  const actionOptions = [
    { label: 'Floating', value: 'floating' },
    { label: 'Running', value: 'running' },
    { label: 'Transforming', value: 'transforming' },
    { label: 'Building', value: 'building' },
    { label: 'Destroying', value: 'destroying' },
    { label: 'Connecting', value: 'connecting' },
    { label: 'Exploring', value: 'exploring' }
  ];

  const handleSelect = (item: { label: string; value: string }) => {
    switch (step) {
      case 'emotions':
        setDreamData(prev => ({ ...prev, emotions: [...prev.emotions, item.value] }));
        break;
      case 'symbols':
        setDreamData(prev => ({ ...prev, symbols: [...prev.symbols, item.value] }));
        break;
      case 'colors':
        setDreamData(prev => ({ ...prev, colors: [...prev.colors, item.value] }));
        break;
      case 'actions':
        setDreamData(prev => ({ ...prev, actions: [...prev.actions, item.value] }));
        break;
    }
  };

  const handleSubmit = () => {
    if (step === 'description') {
      setDreamData(prev => ({ ...prev, description: currentInput }));
      setCurrentInput('');
      setStep('emotions');
    } else if (step === 'emotions' && dreamData.emotions.length > 0) {
      setStep('symbols');
    } else if (step === 'symbols' && dreamData.symbols.length > 0) {
      setStep('colors');
    } else if (step === 'colors' && dreamData.colors.length > 0) {
      setStep('actions');
    } else if (step === 'actions' && dreamData.actions.length > 0) {
      setStep('processing');
      processDream();
    }
  };

  const processDream = async () => {
    // Simulate AI processing
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const dreamAnalysis = `
🌙 Dream Analysis Complete! 🌙

Your dream reveals a ${dreamData.emotions[0]} journey through ${dreamData.symbols[0]} realms.
The ${dreamData.colors[0]} and ${dreamData.colors[1]} colors suggest ${dreamData.actions[0]} possibilities.

💡 Creative Inspiration:
- Generate art: dream-architect visualize "${dreamData.description}" --style surreal
- Create code: dream-architect code "${dreamData.symbols[0]}" --language python --type app
- Explore deeper: dream-architect interactive

✨ Your dream is now a creative catalyst!
    `;
    
    setResult(dreamAnalysis);
    setStep('result');
  };

  if (step === 'welcome') {
    return (
      <Box flexDirection="column" alignItems="center">
        <Text color="magenta" bold>🌙 Dream Architect 🌙</Text>
        <Newline />
        <Text color="cyan">Transform your dreams into creative reality</Text>
        <Newline />
        <Text>Press any key to begin your dream journey...</Text>
        <SelectInput
          items={[{ label: 'Begin Dream Journey', value: 'start' }]}
          onSelect={() => setStep('description')}
        />
      </Box>
    );
  }

  if (step === 'description') {
    return (
      <Box flexDirection="column">
        <Text color="yellow" bold>Describe your dream:</Text>
        <Newline />
        <TextInput
          value={currentInput}
          onChange={setCurrentInput}
          onSubmit={handleSubmit}
          placeholder="I was flying through a crystal city..."
        />
        <Newline />
        <Text color="gray">Press Enter when done</Text>
      </Box>
    );
  }

  if (step === 'emotions') {
    return (
      <Box flexDirection="column">
        <Text color="yellow" bold>What emotions did you feel? (Select multiple)</Text>
        <Newline />
        <Text color="gray">Selected: {dreamData.emotions.join(', ')}</Text>
        <Newline />
        <SelectInput items={emotionOptions} onSelect={handleSelect} />
        <Newline />
        <Text color="gray">Press Enter when done selecting</Text>
        <TextInput value="" onChange={() => {}} onSubmit={handleSubmit} />
      </Box>
    );
  }

  if (step === 'symbols') {
    return (
      <Box flexDirection="column">
        <Text color="yellow" bold>What symbols appeared? (Select multiple)</Text>
        <Newline />
        <Text color="gray">Selected: {dreamData.symbols.join(', ')}</Text>
        <Newline />
        <SelectInput items={symbolOptions} onSelect={handleSelect} />
        <Newline />
        <Text color="gray">Press Enter when done selecting</Text>
        <TextInput value="" onChange={() => {}} onSubmit={handleSubmit} />
      </Box>
    );
  }

  if (step === 'colors') {
    return (
      <Box flexDirection="column">
        <Text color="yellow" bold>What colors stood out? (Select multiple)</Text>
        <Newline />
        <Text color="gray">Selected: {dreamData.colors.join(', ')}</Text>
        <Newline />
        <SelectInput items={colorOptions} onSelect={handleSelect} />
        <Newline />
        <Text color="gray">Press Enter when done selecting</Text>
        <TextInput value="" onChange={() => {}} onSubmit={handleSubmit} />
      </Box>
    );
  }

  if (step === 'actions') {
    return (
      <Box flexDirection="column">
        <Text color="yellow" bold>What actions occurred? (Select multiple)</Text>
        <Newline />
        <Text color="gray">Selected: {dreamData.actions.join(', ')}</Text>
        <Newline />
        <SelectInput items={actionOptions} onSelect={handleSelect} />
        <Newline />
        <Text color="gray">Press Enter when done selecting</Text>
        <TextInput value="" onChange={() => {}} onSubmit={handleSubmit} />
      </Box>
    );
  }

  if (step === 'processing') {
    return (
      <Box flexDirection="column" alignItems="center">
        <Text color="cyan">
          <Spinner type="dots" /> Processing your dream...
        </Text>
        <Newline />
        <Text color="gray">The AI is analyzing your subconscious patterns...</Text>
      </Box>
    );
  }

  if (step === 'result') {
    return (
      <Box flexDirection="column">
        <Text>{result}</Text>
        <Newline />
        <Text color="green">Press Ctrl+C to exit</Text>
      </Box>
    );
  }

  return null;
};