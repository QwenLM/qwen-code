import React, { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'

export default function ChatAssistant() {
  const { state, dispatch } = useApp()
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState([
    {
      id: 1,
      type: 'assistant',
      content: `👋 Hello! I'm your SocialFlow assistant.\n\nI can help you create posts, schedule content, or manage your social media. Try saying:\n\n• "Create a post about our spring sale"\n• "Schedule a promotional post for Monday"\n• "Generate content about device tips"\n• "Write an engagement question"\n\nYou can type or use 🎤 voice input!`
    }
  ])
  const [input, setInput] = useState('')
  const [isListening, setIsListening] = useState(false)
  const [isTyping, setIsTyping] = useState(false)
  const [suggestedImage, setSuggestedImage] = useState(null)
  const messagesEndRef = useRef(null)
  const recognitionRef = useRef(null)
  const navigate = useNavigate()

  // Get AI learned data for personalized content
  const aiLearned = state.aiLearned
  const businessInfo = state.business

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Initialize Speech Recognition
  useEffect(() => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
      recognitionRef.current = new SpeechRecognition()
      recognitionRef.current.continuous = false
      recognitionRef.current.interimResults = false

      recognitionRef.current.onresult = (event) => {
        const transcript = event.results[0][0].transcript
        setInput(transcript)
        setIsListening(false)
        handleSend(transcript)
      }

      recognitionRef.current.onerror = () => {
        setIsListening(false)
        addMessage('assistant', "Sorry, I couldn't understand that. Please try again.")
      }

      recognitionRef.current.onend = () => {
        setIsListening(false)
      }
    }
  }, [])

  const addMessage = (type, content) => {
    setMessages(prev => [...prev, { id: Date.now(), type, content }])
  }

  const toggleListening = () => {
    if (!recognitionRef.current) {
      addMessage('assistant', "🎤 Voice input is not supported in your browser. Please type your message.")
      return
    }

    if (isListening) {
      recognitionRef.current.stop()
      setIsListening(false)
    } else {
      recognitionRef.current.start()
      setIsListening(true)
    }
  }

  const parseCommand = (text) => {
    const lowerText = text.toLowerCase()
    
    // Intent detection with priority
    const intents = {
      schedule: /schedule|post on|at |say on|for (tomorrow|next|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
      promotional: /sale|promo|discount|offer|deal|advertise|save|special|bargain/i,
      educational: /tip|how to|learn|guide|tutorial|explain|teach/i,
      announcement: /announce|news|launch|introduce|new (service|product|feature)/i,
      engagement: /question|ask|quiz|poll|engage|what do you|互动/i,
      testimonial: /customer|review|testimonial|feedback|success story|thank/i,
      behindScenes: /behind|behind the scenes|team|our|workplace/i,
    }

    // Detect primary intent
    let detectedIntent = 'general'
    for (const [intent, pattern] of Object.entries(intents)) {
      if (pattern.test(text)) {
        detectedIntent = intent
        break
      }
    }

    // Extract topic - remove command words
    let topic = text
      .replace(/create|make|write|generate|post|schedule|help me|i want|i need|can you|please/gi, '')
      .replace(/about|for|on|at|the|a|an|to|with/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    // If topic is too short, use the original text
    if (!topic || topic.length < 3) {
      topic = text.replace(/create|make|write|generate|post|schedule|help me/i, '').trim() || text
    }

    // Extract date/time if scheduling
    const datePatterns = {
      tomorrow: /tomorrow/i,
      nextMonday: /next monday/i,
      nextTuesday: /next tuesday/i,
      nextWeek: /next week/i,
      thisWeek: /this week/i,
    }

    let scheduleDate = null
    for (const [day, pattern] of Object.entries(datePatterns)) {
      if (pattern.test(text)) {
        scheduleDate = day
        break
      }
    }

    return { intent: detectedIntent, topic, rawText: text, scheduleDate }
  }

  const generatePostContent = (parsed) => {
    const { intent, topic } = parsed
    const brandVoice = aiLearned.brandVoice || 'Professional tech content'
    const topTopics = aiLearned.topTopics || []
    
    // Generate content based on detected intent and topic
    const contentTemplates = {
      promotional: [
        `🎉 ${topic}!\n\nDon't miss out on this amazing opportunity! We've got something special just for you.\n\nBook now and save! This offer won't last forever.\n\n#${topic.replace(/\s+/g, '')} #SpecialOffer #LimitedTime`,
        `🏷️ ${topic}\n\nReady to save? We've got you covered!\n\nYour satisfaction is our priority. Stop by and see what we can do for you!\n\n#${topic.replace(/\s+/g, '')} #Deal #DontMissOut`,
      ],
      educational: [
        `💡 ${topic}\n\nHere's what you need to know:\n\n✓ Stay informed\n✓ Take action\n✓ See results\n\nNeed help? We're just a message away! #Tips #HowTo #TechTips`,
        `📚 ${topic}\n\nPro tip: Regular maintenance saves you time and money!\n\nWhat topics would you like to learn about? Let us know in the comments! 👇\n\n#Education #Maintenance #${topic.replace(/\s+/g, '')}`,
      ],
      announcement: [
        `📢 ${topic}\n\nWe're thrilled to share this with you! Our team has been working hard to bring you the best experience.\n\nStay connected for more updates! 💙\n\n#Announcement #New #Exciting`,
        `🚀 Big news! ${topic}\n\nThis is just the beginning. Stay tuned for what's coming next!\n\nThank you for being part of our journey.\n\n#Launch #Update #ComingSoon`,
      ],
      engagement: [
        `💬 ${topic}\n\nWe want to hear from you! Drop your answers in the comments below 👇\n\nYour feedback means the world to us! 💙\n\n#Engagement #Community #LetsChat`,
        `❓ ${topic}\n\nLet us know in the comments! Don't forget to share with friends who might relate!\n\n👇👇👇\n\n#Community #Discussion #ShareYourThoughts`,
      ],
      testimonial: [
        `⭐ ${topic}\n\nThank you for the wonderful feedback! Nothing makes us happier than seeing our customers succeed.\n\nTo all our amazing followers - you're the best! 💙\n\n#CustomerLove #Grateful #Testimonial`,
        `💙 ${topic}\n\nStories like this inspire us to keep doing what we love!\n\nHave a success story to share? We'd love to hear it!\n\n#CustomerSpotlight #Community #ThankYou`,
      ],
      behindScenes: [
        `👀 Behind the scenes at ${businessInfo.name || 'our studio'}!\n\n${topic}\n\nMeet the team that makes it all happen! Swipe to see more 👉\n\n#BehindTheScenes #TeamWork #OurProcess`,
        `🏠 ${topic}\n\nHere's a look at how we work!\n\nEvery day is a new opportunity to help our customers. That's what drives us! 💪\n\n#BehindTheScenes #WorkLife #Team`,
      ],
      general: [
        `✨ ${topic}\n\nWe're here to help you every step of the way!\n\nHave questions? Drop us a message! 💬\n\n#SocialFlow #HereToHelp`,
        `🌟 ${topic}\n\nThank you for being part of our community!\n\nWhat would you like to see more of? Let us know! 👇\n\n#Community #Grateful #Together`,
      ]
    }

    const contents = contentTemplates[intent] || contentTemplates.general
    return contents[Math.floor(Math.random() * contents.length)]
  }

  const generateImageSuggestion = (intent, topic) => {
    // Suggest relevant images based on intent
    const imageMap = {
      promotional: 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=400',
      educational: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=400',
      announcement: 'https://images.unsplash.com/photo-1505373877841-8d25f7d46678?w=400',
      engagement: 'https://images.unsplash.com/photo-1521737604893-d14cc237f11d?w=400',
      testimonial: 'https://images.unsplash.com/photo-1551836022-deb4988cc6c0?w=400',
      behindScenes: 'https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=400',
      general: 'https://images.unsplash.com/photo-1557804506-669a67965ba0?w=400',
    }
    return imageMap[intent] || imageMap.general
  }

  const handleSend = async (text = input) => {
    if (!text.trim()) return

    // Add user message
    addMessage('user', text)
    setInput('')
    setIsTyping(true)

    // Parse the command
    const parsed = parseCommand(text)
    
    // Simulate AI processing
    await new Promise(resolve => setTimeout(resolve, 800))
    
    // Show understanding
    const understandingResponses = {
      promotional: "🎯 Got it! Creating a promotional post...",
      educational: "📚 Perfect! Generating an educational post...",
      announcement: "📢 Exciting! Making an announcement post...",
      engagement: "💬 Great! Creating an engagement post...",
      testimonial: "⭐ Nice! Writing a testimonial post...",
      behindScenes: "👀 Cool! Creating a behind-the-scenes post...",
      schedule: "📅 On it! Setting up your scheduled post...",
      general: "✨ Got it! Creating a post for you...",
    }
    
    addMessage('assistant', understandingResponses[parsed.intent] || understandingResponses.general)
    setIsTyping(false)

    // Generate content
    await new Promise(resolve => setTimeout(resolve, 600))
    
    const postContent = generatePostContent(parsed)
    const suggestedImg = generateImageSuggestion(parsed.intent, parsed.topic)
    
    setSuggestedImage(suggestedImg)

    // Store in context
    dispatch({ type: 'SET_CHAT_CONTENT', payload: { content: postContent, image: suggestedImg, topic: parsed.topic } })

    // Show the generated content
    addMessage('assistant', `📝 Here's your generated post:\n\n"${postContent}"`)
    
    await new Promise(resolve => setTimeout(resolve, 400))
    
    addMessage('assistant', `📷 Suggested image: I've selected a matching image for your post. Use the buttons below to proceed!`)
  }

  const handleUseContent = () => {
    const content = state.chatGeneratedContent
    if (content) {
      navigate('/compose', { state: { content: content.content, image: content.image } })
      setIsOpen(false)
    }
  }

  const handleSchedulePost = () => {
    handleUseContent()
    // The compose page will open with the content
  }

  const handleQuickCommand = (command) => {
    handleSend(command)
  }

  const quickCommands = [
    { label: 'Promotional post', icon: '🎯', command: 'Create a promotional post about our spring sale' },
    { label: 'Share a tip', icon: '💡', command: 'Share a tech maintenance tip' },
    { label: 'Announce news', icon: '📢', command: 'Announce our new service' },
    { label: 'Engage followers', icon: '💬', command: 'Create an engagement question for followers' },
    { label: 'Behind scenes', icon: '👀', command: 'Share behind the scenes at our business' },
    { label: 'Customer story', icon: '⭐', command: 'Write a customer testimonial post' },
  ]

  return (
    <>
      {/* Floating Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`fixed bottom-6 right-6 w-16 h-16 rounded-full bg-gradient-to-br from-primary to-secondary shadow-lg hover:shadow-xl transition-all duration-300 flex items-center justify-center z-50 group ${isOpen ? 'rotate-90' : ''}`}
      >
        {isOpen ? (
          <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <div className="relative">
            <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <span className="absolute -top-1 -right-1 w-3 h-3 bg-accent rounded-full animate-pulse" />
          </div>
        )}
        <span className="absolute right-full mr-3 px-3 py-2 bg-surface rounded-lg text-sm whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
          AI Assistant
        </span>
      </button>

      {/* Chat Panel */}
      {isOpen && (
        <div className="fixed bottom-24 right-6 w-[420px] max-w-[calc(100vw-3rem)] h-[550px] glass-strong rounded-2xl overflow-hidden flex flex-col z-50 animate-slide-up">
          {/* Header */}
          <div className="p-4 border-b border-white/10 bg-gradient-to-r from-primary/10 to-secondary/10">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary to-secondary flex items-center justify-center">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </div>
              <div>
                <h3 className="font-bold">SocialFlow Assistant</h3>
                <p className="text-xs text-muted">Voice & text commands • AI-powered</p>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-emerald-400" />
                <span className="text-xs text-emerald-400">Online</span>
              </div>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] px-4 py-3 rounded-2xl ${
                    msg.type === 'user'
                      ? 'bg-gradient-to-br from-primary to-secondary text-white rounded-br-md'
                      : 'bg-surface border border-white/10 text-white rounded-bl-md'
                  }`}
                >
                  <p className="text-sm whitespace-pre-line">{msg.content}</p>
                </div>
              </div>
            ))}
            
            {isTyping && (
              <div className="flex justify-start">
                <div className="bg-surface border border-white/10 px-4 py-3 rounded-2xl rounded-bl-md">
                  <div className="flex gap-1">
                    <div className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <div className="w-2 h-2 bg-secondary rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <div className="w-2 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            )}
            
            {/* Suggested Image Preview */}
            {suggestedImage && !isTyping && (
              <div className="flex justify-start">
                <div className="bg-surface border border-white/10 p-3 rounded-2xl rounded-bl-md">
                  <p className="text-xs text-muted mb-2">📷 Suggested Image</p>
                  <img src={suggestedImage} alt="" className="w-full h-32 object-cover rounded-lg" />
                </div>
              </div>
            )}
            
            <div ref={messagesEndRef} />
          </div>

          {/* Action Buttons */}
          {state.chatGeneratedContent && !isTyping && (
            <div className="px-4 pb-2 flex gap-2">
              <button
                onClick={handleUseContent}
                className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-primary to-secondary text-white text-sm font-medium flex items-center justify-center gap-2 hover:shadow-lg hover:shadow-primary/30 transition-all"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                Edit & Post
              </button>
              <button
                onClick={handleSchedulePost}
                className="flex-1 py-2.5 rounded-xl bg-surface border border-white/10 text-white text-sm font-medium flex items-center justify-center gap-2 hover:bg-white/5 transition-all"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                Schedule
              </button>
            </div>
          )}

          {/* Quick Commands */}
          <div className="px-4 pb-2">
            <div className="flex gap-2 overflow-x-auto pb-2">
              {quickCommands.slice(0, 4).map((cmd, i) => (
                <button
                  key={i}
                  onClick={() => handleQuickCommand(cmd.command)}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl bg-surface/50 border border-white/5 text-xs whitespace-nowrap hover:bg-surface hover:border-primary/30 hover:text-primary transition-all"
                >
                  <span>{cmd.icon}</span>
                  <span>{cmd.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Input */}
          <div className="p-4 border-t border-white/10 bg-surface/30">
            <div className="flex items-center gap-3">
              <button
                onClick={toggleListening}
                className={`w-11 h-11 rounded-xl flex items-center justify-center transition-all ${
                  isListening
                    ? 'bg-red-500/20 text-red-400 animate-pulse border border-red-500/30'
                    : 'bg-white/5 text-muted hover:text-white hover:bg-white/10 border border-transparent'
                }`}
              >
                {isListening ? (
                  <div className="relative">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                    <span className="absolute -top-1 -right-1 w-2 h-2 bg-red-400 rounded-full animate-ping" />
                  </div>
                ) : (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                )}
              </button>
              
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleSend()}
                placeholder="Type a command or speak..."
                className="flex-1 bg-dark/50 border border-white/10 rounded-xl px-4 py-3 text-sm placeholder-muted focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 transition-all"
              />
              
              <button
                onClick={() => handleSend()}
                disabled={!input.trim()}
                className="w-11 h-11 rounded-xl bg-gradient-to-br from-primary to-secondary flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed hover:shadow-lg hover:shadow-primary/30 transition-all"
              >
                <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              </button>
            </div>

            {isListening && (
              <div className="mt-2 text-center text-sm text-red-400 animate-pulse flex items-center justify-center gap-2">
                <div className="w-2 h-2 bg-red-400 rounded-full animate-ping" />
                🎤 Listening... Speak now
              </div>
            )}

            {/* Help text */}
            <p className="mt-2 text-center text-xs text-muted">
              Try: "Create a post about our spring sale" or "Share a tech tip"
            </p>
          </div>
        </div>
      )}
    </>
  )
}