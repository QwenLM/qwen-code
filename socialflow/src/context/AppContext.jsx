import React, { createContext, useContext, useReducer, useState } from 'react'

const AppContext = createContext()

const initialState = {
  // Business Profile
  business: {
    name: '',
    description: '',
    industry: '',
    services: [],
    targetAudience: '',
    brandGuidelines: '',
    logo: null,
    coverImage: null
  },
  
  // Connected Accounts
  accounts: [
    { id: '1', platform: 'twitter', name: 'TechFlow Studio', handle: '@techflow', connected: true, followers: 12400, color: '#1DA1F2' },
    { id: '2', platform: 'facebook', name: 'TechFlow Studio', handle: 'techflowstudio', connected: true, followers: 8500, color: '#4267B2' },
    { id: '3', platform: 'instagram', name: 'TechFlow Studio', handle: '@techflow.studio', connected: false, followers: 0, color: '#E4405F' },
    { id: '4', platform: 'linkedin', name: 'TechFlow Studio', handle: 'techflow-studio', connected: false, followers: 0, color: '#0A66C2' },
  ],

  // AI Learning Data
  aiLearned: {
    brandVoice: 'Professional yet approachable tech content with a focus on practical solutions',
    topTopics: ['Device Repair', 'Tech Tips', 'Customer Stories', 'New Products'],
    bestPostingTimes: ['9:00 AM - 11:00 AM', '6:00 PM - 8:00 PM', '12:00 PM - 1:00 PM'],
    audienceEngagement: {
      likes: 847,
      comments: 124,
      shares: 89
    },
    contentStyles: ['How-to guides', 'Before/After', 'Quick tips', 'Behind the scenes']
  },

  // Posts
  posts: [
    { id: '1', content: '🎉 Exciting news! We just upgraded our repair station with the latest diagnostic equipment. Faster repairs, better results! #TechFlow #Repair', image: 'https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=400', scheduledFor: '2024-03-15T10:00:00', platforms: ['twitter', 'facebook'], status: 'scheduled', stats: null },
    { id: '2', content: '💡 Pro tip: Always backup your data before any repair! It takes 5 minutes but saves hours of stress. What\'s your backup routine?', image: null, scheduledFor: null, platforms: ['twitter'], status: 'draft', stats: null },
    { id: '3', content: 'Customer spotlight: Thanks to @sarah_tech for sharing her experience! We love hearing from you 💙', image: 'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=400', scheduledFor: '2024-03-12T14:00:00', platforms: ['twitter', 'instagram'], status: 'posted', stats: { likes: 234, comments: 45, shares: 12 } },
  ],

  // Queue
  queue: [
    { id: 'q1', content: '🚀 Weekend special: Get 20% off screen replacements this Saturday & Sunday!', image: 'https://images.unsplash.com/photo-1593508512255-86ab42a8e620?w=400', nextPost: '2024-03-16T09:00:00', platforms: ['twitter', 'facebook'] },
  ],

  // Settings
  settings: {
    autoPost: true,
    postInterval: 4,
    optimalTimes: true,
    timezone: 'America/New_York'
  },

  // UI State
  activeModal: null,
  selectedPost: null,
  aiGenerating: false,
  aiSuggestions: []
}

function appReducer(state, action) {
  switch (action.type) {
    case 'UPDATE_BUSINESS':
      return { ...state, business: { ...state.business, ...action.payload } }
    
    case 'SET_CHAT_CONTENT':
      return { ...state, chatGeneratedContent: action.payload }
    
    case 'ADD_ACCOUNT':
      return { ...state, accounts: [...state.accounts, action.payload] }
    
    case 'UPDATE_ACCOUNT':
      return { 
        ...state, 
        accounts: state.accounts.map(acc => 
          acc.id === action.payload.id ? { ...acc, ...action.payload } : acc
        ) 
      }
    
    case 'REMOVE_ACCOUNT':
      return { 
        ...state, 
        accounts: state.accounts.filter(acc => acc.id !== action.payload) 
      }
    
    case 'UPDATE_AI_LEARNED':
      return { ...state, aiLearned: { ...state.aiLearned, ...action.payload } }
    
    case 'ADD_POST':
      return { ...state, posts: [action.payload, ...state.posts] }
    
    case 'UPDATE_POST':
      return { 
        ...state, 
        posts: state.posts.map(post => 
          post.id === action.payload.id ? { ...post, ...action.payload } : post
        ) 
      }
    
    case 'DELETE_POST':
      return { 
        ...state, 
        posts: state.posts.filter(post => post.id !== action.payload) 
      }
    
    case 'ADD_TO_QUEUE':
      return { ...state, queue: [...state.queue, action.payload] }
    
    case 'REMOVE_FROM_QUEUE':
      return { 
        ...state, 
        queue: state.queue.filter(item => item.id !== action.payload) 
      }
    
    case 'UPDATE_SETTINGS':
      return { ...state, settings: { ...state.settings, ...action.payload } }
    
    case 'SET_MODAL':
      return { ...state, activeModal: action.payload }
    
    case 'SET_AI_GENERATING':
      return { ...state, aiGenerating: action.payload }
    
    case 'SET_AI_SUGGESTIONS':
      return { ...state, aiSuggestions: action.payload }
    
    default:
      return state
  }
}

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(appReducer, initialState)

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  const context = useContext(AppContext)
  if (!context) {
    throw new Error('useApp must be used within AppProvider')
  }
  return context
}