import React, { useState, useEffect } from 'react'
import { useApp } from '../context/AppContext'
import { useLocation } from 'react-router-dom'

const platformConfig = {
  twitter: { name: 'Twitter/X', color: '#1DA1F2', maxLength: 280, icon: '𝕏' },
  facebook: { name: 'Facebook', color: '#4267B2', maxLength: 5000, icon: 'f' },
  instagram: { name: 'Instagram', color: '#E4405F', maxLength: 2200, icon: '📷' },
  linkedin: { name: 'LinkedIn', color: '#0A66C2', maxLength: 3000, icon: 'in' }
}

const contentTypes = [
  { id: 'promotional', label: '🎯 Promotional', emoji: '🎯' },
  { id: 'educational', label: '📚 Educational', emoji: '📚' },
  { id: 'engagement', label: '💬 Engagement', emoji: '💬' },
  { id: 'announcement', label: '📢 Announcement', emoji: '📢' }
]

const imageSuggestions = [
  'https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=400',
  'https://images.unsplash.com/photo-1593508512255-86ab42a8e620?w=400',
  'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=400',
  'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400'
]

export default function Compose() {
  const location = useLocation()
  const { state, dispatch } = useApp()
  const [content, setContent] = useState('')
  const [selectedPlatforms, setSelectedPlatforms] = useState(['twitter'])
  const [selectedImage, setSelectedImage] = useState(null)
  const [contentType, setContentType] = useState('educational')
  const [showAIPanel, setShowAIPanel] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiSuggestions, setAiSuggestions] = useState([])
  const [scheduleOption, setScheduleOption] = useState('now')
  const [scheduleDate, setScheduleDate] = useState('')
  const [scheduleTime, setScheduleTime] = useState('')

  // Receive content from chat assistant
  useEffect(() => {
    if (location.state?.content) {
      setContent(location.state.content)
    }
    if (location.state?.image) {
      setSelectedImage(location.state.image)
    }
  }, [location.state])

  // Clear state when component unmounts or location changes
  useEffect(() => {
    return () => {
      // Don't clear if navigating within the app
    }
  }, [])

  const connectedAccounts = state.accounts.filter(a => a.connected)

  const togglePlatform = (platform) => {
    setSelectedPlatforms(prev => 
      prev.includes(platform) 
        ? prev.filter(p => p !== platform)
        : [...prev, platform]
    )
  }

  const handleGenerateAI = () => {
    setAiLoading(true)
    setTimeout(() => {
      setAiSuggestions([
        `✨ Unlock your device's full potential with our expert repair services! Fast, reliable, and affordable. Book now and experience the difference. #TechRepair #DeviceCare`,
        `🔧 Don't let a cracked screen slow you down! Our certified technicians have you covered. Walk-ins welcome or book online. Your device deserves the best! #ScreenRepair`,
        `💡 Pro tip: Regular maintenance extends your device's life! Let us help you keep things running smoothly. Free diagnostics available. #TechTips #DeviceMaintenance`
      ])
      setAiLoading(false)
    }, 2000)
  }

  const applySuggestion = (suggestion) => {
    setContent(suggestion)
    setAiSuggestions([])
    setShowAIPanel(false)
  }

  const handlePost = () => {
    const newPost = {
      id: Date.now().toString(),
      content,
      image: selectedImage,
      scheduledFor: scheduleOption === 'schedule' ? `${scheduleDate}T${scheduleTime}:00` : null,
      platforms: selectedPlatforms,
      status: scheduleOption === 'now' ? 'posted' : 'scheduled',
      stats: null
    }
    dispatch({ type: 'ADD_POST', payload: newPost })
    setContent('')
    setSelectedImage(null)
    setScheduleOption('now')
  }

  const charCount = selectedPlatforms.length > 0 
    ? Math.min(...selectedPlatforms.map(p => platformConfig[p]?.maxLength || 5000))
    : 5000

  return (
    <div className="p-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-4xl font-bold mb-2">Create Post</h1>
        <p className="text-muted">Craft your message and publish across platforms</p>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Main Composer */}
        <div className="col-span-2 space-y-6">
          {/* Content Type Selector */}
          <div className="card">
            <h3 className="text-sm font-medium text-muted mb-3">Content Type</h3>
            <div className="flex gap-3">
              {contentTypes.map((type) => (
                <button
                  key={type.id}
                  onClick={() => setContentType(type.id)}
                  className={`flex-1 py-3 px-4 rounded-xl border transition-all duration-300 ${
                    contentType === type.id
                      ? 'bg-primary/10 border-primary/50 text-primary'
                      : 'bg-dark/50 border-white/5 text-muted hover:border-white/10'
                  }`}
                >
                  <span className="text-lg mr-2">{type.emoji}</span>
                  <span className="text-sm font-medium">{type.label.split(' ')[1]}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Compose Area */}
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-muted">Write your post</h3>
              <button
                onClick={() => setShowAIPanel(!showAIPanel)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-primary/20 to-secondary/20 text-primary hover:from-primary/30 hover:to-secondary/30 transition-all"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                <span className="text-sm font-medium">AI Assist</span>
              </button>
            </div>
            
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="What's on your mind? Share updates, tips, or news with your audience..."
              className="w-full h-40 bg-dark/50 border border-white/5 rounded-xl p-4 text-white placeholder-muted focus:outline-none focus:border-primary/50 transition-all resize-none"
            />
            
            <div className="flex items-center justify-between mt-4">
              <div className="flex gap-2">
                <button className="p-2 rounded-lg hover:bg-white/5 transition-colors">
                  <svg className="w-5 h-5 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                  </svg>
                </button>
                <button className="p-2 rounded-lg hover:bg-white/5 transition-colors">
                  <svg className="w-5 h-5 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </button>
                <label className="p-2 rounded-lg hover:bg-white/5 transition-colors cursor-pointer">
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                    const file = e.target.files[0]
                    if (file) setSelectedImage(URL.createObjectURL(file))
                  }} />
                  <svg className="w-5 h-5 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </label>
              </div>
              <span className={`text-sm ${content.length > charCount ? 'text-red-400' : 'text-muted'}`}>
                {content.length}/{charCount}
              </span>
            </div>
          </div>

          {/* AI Suggestions Panel */}
          {showAIPanel && (
            <div className="card border-primary/30 animate-slide-up">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-secondary flex items-center justify-center">
                    <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                  </div>
                  <span className="font-medium">AI Content Suggestions</span>
                </div>
                <button
                  onClick={handleGenerateAI}
                  disabled={aiLoading}
                  className="px-4 py-2 rounded-xl bg-primary/20 text-primary hover:bg-primary/30 disabled:opacity-50 transition-all text-sm font-medium"
                >
                  {aiLoading ? 'Generating...' : '✨ Generate'}
                </button>
              </div>

              {aiSuggestions.length > 0 ? (
                <div className="space-y-3">
                  {aiSuggestions.map((suggestion, i) => (
                    <div
                      key={i}
                      className="p-4 rounded-xl bg-dark/50 border border-white/5 hover:border-primary/30 transition-all cursor-pointer group"
                      onClick={() => applySuggestion(suggestion)}
                    >
                      <p className="text-sm mb-3">{suggestion}</p>
                      <button className="text-xs text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                        Apply this content →
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-center text-muted py-8">
                  Click "Generate" to get AI-powered content suggestions based on your business profile
                </p>
              )}
            </div>
          )}

          {/* Image Preview */}
          {selectedImage && (
            <div className="card relative">
              <img src={selectedImage} alt="" className="w-full h-48 object-cover rounded-xl" />
              <button
                onClick={() => setSelectedImage(null)}
                className="absolute top-4 right-4 w-8 h-8 rounded-full bg-dark/80 flex items-center justify-center hover:bg-red-500/20 transition-colors"
              >
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          {/* Schedule Options */}
          <div className="card">
            <h3 className="text-sm font-medium text-muted mb-4">Publishing Options</h3>
            <div className="flex gap-3 mb-4">
              <button
                onClick={() => setScheduleOption('now')}
                className={`flex-1 py-3 px-4 rounded-xl border transition-all ${
                  scheduleOption === 'now'
                    ? 'bg-primary/10 border-primary/50 text-primary'
                    : 'bg-dark/50 border-white/5 text-muted'
                }`}
              >
                <span className="text-lg mr-2">🚀</span>
                Post Now
              </button>
              <button
                onClick={() => setScheduleOption('schedule')}
                className={`flex-1 py-3 px-4 rounded-xl border transition-all ${
                  scheduleOption === 'schedule'
                    ? 'bg-primary/10 border-primary/50 text-primary'
                    : 'bg-dark/50 border-white/5 text-muted'
                }`}
              >
                <span className="text-lg mr-2">📅</span>
                Schedule
              </button>
              <button
                onClick={() => setScheduleOption('queue')}
                className={`flex-1 py-3 px-4 rounded-xl border transition-all ${
                  scheduleOption === 'queue'
                    ? 'bg-primary/10 border-primary/50 text-primary'
                    : 'bg-dark/50 border-white/5 text-muted'
                }`}
              >
                <span className="text-lg mr-2">📋</span>
                Add to Queue
              </button>
            </div>

            {scheduleOption === 'schedule' && (
              <div className="flex gap-4 animate-fade-in">
                <input
                  type="date"
                  value={scheduleDate}
                  onChange={(e) => setScheduleDate(e.target.value)}
                  className="input-field flex-1"
                />
                <input
                  type="time"
                  value={scheduleTime}
                  onChange={(e) => setScheduleTime(e.target.value)}
                  className="input-field flex-1"
                />
              </div>
            )}

            {scheduleOption === 'queue' && (
              <div className="p-4 rounded-xl bg-dark/50 border border-white/5 animate-fade-in">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-accent to-orange-500 flex items-center justify-center">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div>
                    <p className="font-medium">Auto-Post Queue</p>
                    <p className="text-sm text-muted">Next post in 4 hours based on optimal timing</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Panel */}
        <div className="space-y-6">
          {/* Platform Selector */}
          <div className="card">
            <h3 className="text-sm font-medium text-muted mb-4">Select Platforms</h3>
            <div className="space-y-3">
              {connectedAccounts.map((account) => {
                const config = platformConfig[account.platform]
                const isSelected = selectedPlatforms.includes(account.platform)
                return (
                  <button
                    key={account.id}
                    onClick={() => togglePlatform(account.platform)}
                    className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all ${
                      isSelected
                        ? 'bg-white/5 border-primary/50'
                        : 'bg-dark/50 border-white/5 hover:border-white/10'
                    }`}
                  >
                    <div 
                      className="w-10 h-10 rounded-xl flex items-center justify-center"
                      style={{ backgroundColor: config.color + '20' }}
                    >
                      <span className="text-lg" style={{ color: config.color }}>{config.icon}</span>
                    </div>
                    <div className="flex-1 text-left">
                      <p className="font-medium">{config.name}</p>
                      <p className="text-xs text-muted">{account.handle}</p>
                    </div>
                    <div className={`w-5 h-5 rounded-full border-2 transition-all ${
                      isSelected ? 'bg-primary border-primary' : 'border-muted'
                    }`}>
                      {isSelected && (
                        <svg className="w-3 h-3 text-white m-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Image Suggestions */}
          <div className="card">
            <h3 className="text-sm font-medium text-muted mb-4">Image Suggestions</h3>
            <div className="grid grid-cols-2 gap-3">
              {imageSuggestions.map((img, i) => (
                <div
                  key={i}
                  onClick={() => setSelectedImage(img)}
                  className={`relative rounded-xl overflow-hidden cursor-pointer group ${
                    selectedImage === img ? 'ring-2 ring-primary' : ''
                  }`}
                >
                  <img src={img} alt="" className="w-full h-24 object-cover" />
                  <div className="absolute inset-0 bg-gradient-to-t from-dark/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                  <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="text-xs bg-white/20 px-2 py-1 rounded-lg">Select</span>
                  </div>
                </div>
              ))}
            </div>
            <button className="w-full mt-3 py-2 rounded-xl border border-white/10 text-sm text-muted hover:text-white hover:border-white/20 transition-all">
              Browse Stock Library
            </button>
          </div>

          {/* Post Button */}
          <button
            onClick={handlePost}
            disabled={!content || selectedPlatforms.length === 0}
            className="w-full btn-primary py-4 text-lg disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
          >
            {scheduleOption === 'now' ? '🚀 Post Now' : scheduleOption === 'schedule' ? '📅 Schedule Post' : '📋 Add to Queue'}
          </button>
        </div>
      </div>
    </div>
  )
}