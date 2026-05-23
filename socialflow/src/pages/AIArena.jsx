import React, { useState } from 'react'
import { useApp } from '../context/AppContext'

export default function AIArena() {
  const { state } = useApp()
  const [mode, setMode] = useState('content') // 'content' or 'image'
  const [prompt, setPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [contentResults, setContentResults] = useState([])
  const [imageResults, setImageResults] = useState([])
  const [selectedStyle, setSelectedStyle] = useState('professional')

  const contentStyles = [
    { id: 'professional', label: 'Professional', emoji: '💼' },
    { id: 'casual', label: 'Casual', emoji: '😊' },
    { id: 'fun', label: 'Fun & Playful', emoji: '🎉' },
    { id: 'educational', label: 'Educational', emoji: '📚' },
    { id: 'promotional', label: 'Promotional', emoji: '🎯' }
  ]

  const contentTypes = [
    { id: 'post', label: 'Social Post', icon: '📱' },
    { id: 'story', label: 'Story', icon: '📖' },
    { id: 'caption', label: 'Caption', icon: '✍️' },
    { id: 'thread', label: 'Thread', icon: '🧵' }
  ]

  const handleGenerateContent = () => {
    setGenerating(true)
    setTimeout(() => {
      setContentResults([
        {
          id: 1,
          content: `✨ Ready to transform your tech? Our latest diagnostic tools catch issues before they become problems. Book your free checkup today! #TechRepair #DeviceCare #TechTips`,
          type: 'post',
          hashtags: ['#TechRepair', '#DeviceCare', '#TechTips'],
          engagement: 'high'
        },
        {
          id: 2,
          content: `🔥 Don't let a slow device hold you back! Our certified technicians diagnose and fix issues in record time. Your tech deserves the best care! 🚀 #SameDayRepair #TechExperts`,
          type: 'post',
          hashtags: ['#SameDayRepair', '#TechExperts'],
          engagement: 'medium'
        },
        {
          id: 3,
          content: `💡 Pro tip: Regular maintenance extends your device's life by up to 40%. Schedule a tune-up and keep your tech running smoothly for years to come! #TechMaintenance #DeviceCare`,
          type: 'educational',
          hashtags: ['#TechMaintenance', '#DeviceCare'],
          engagement: 'high'
        }
      ])
      setGenerating(false)
    }, 2500)
  }

  const handleGenerateImage = () => {
    setGenerating(true)
    setTimeout(() => {
      setImageResults([
        {
          id: 1,
          url: 'https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=600',
          prompt: 'Modern repair workshop with technicians working on devices',
          style: 'photography'
        },
        {
          id: 2,
          url: 'https://images.unsplash.com/photo-1593508512255-86ab42a8e620?w=600',
          prompt: 'Glowing smartphone with colorful repair tools',
          style: 'digital art'
        },
        {
          id: 3,
          url: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600',
          prompt: 'Elegant watch repair with precision tools',
          style: 'photography'
        },
        {
          id: 4,
          url: 'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=600',
          prompt: 'Happy technician holding a repaired device',
          style: 'photography'
        }
      ])
      setGenerating(false)
    }, 3000)
  }

  const handleUseContent = (content) => {
    // Navigate to compose with this content
    alert('Redirecting to Compose with selected content...')
  }

  const handleUseImage = (image) => {
    // Navigate to compose with this image
    alert('Redirecting to Compose with selected image...')
  }

  return (
    <div className="p-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-4xl font-bold mb-2">AI Arena</h1>
        <p className="text-muted">Generate content and images powered by AI</p>
      </div>

      {/* Mode Selector */}
      <div className="flex gap-4 mb-8">
        <button
          onClick={() => { setMode('content'); setContentResults([]); setImageResults([]) }}
          className={`flex-1 p-6 rounded-2xl border transition-all ${
            mode === 'content'
              ? 'bg-gradient-to-br from-primary/10 to-secondary/10 border-primary/50'
              : 'bg-surface border-white/5 hover:border-white/10'
          }`}
        >
          <div className="text-4xl mb-3">✍️</div>
          <h3 className="text-lg font-bold mb-1">Content Generation</h3>
          <p className="text-sm text-muted">AI-powered post ideas and captions</p>
        </button>
        <button
          onClick={() => { setMode('image'); setContentResults([]); setImageResults([]) }}
          className={`flex-1 p-6 rounded-2xl border transition-all ${
            mode === 'image'
              ? 'bg-gradient-to-br from-accent/10 to-orange-500/10 border-accent/50'
              : 'bg-surface border-white/5 hover:border-white/10'
          }`}
        >
          <div className="text-4xl mb-3">🎨</div>
          <h3 className="text-lg font-bold mb-1">Image Creation</h3>
          <p className="text-sm text-muted">Generate or find the perfect images</p>
        </button>
      </div>

      {mode === 'content' ? (
        <div className="space-y-6">
          {/* Content Generator Input */}
          <div className="card">
            <h3 className="text-lg font-bold mb-4">Generate Content Ideas</h3>
            
            <div className="space-y-4">
              {/* Style Selector */}
              <div>
                <label className="block text-sm font-medium text-muted mb-2">Content Style</label>
                <div className="flex gap-3">
                  {contentStyles.map((style) => (
                    <button
                      key={style.id}
                      onClick={() => setSelectedStyle(style.id)}
                      className={`flex items-center gap-2 px-4 py-2 rounded-xl border transition-all ${
                        selectedStyle === style.id
                          ? 'bg-primary/10 border-primary/50'
                          : 'bg-dark/50 border-white/5 hover:border-white/10'
                      }`}
                    >
                      <span>{style.emoji}</span>
                      <span className="text-sm">{style.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Type Selector */}
              <div>
                <label className="block text-sm font-medium text-muted mb-2">Content Type</label>
                <div className="flex gap-3">
                  {contentTypes.map((type) => (
                    <button
                      key={type.id}
                      className="flex items-center gap-2 px-4 py-2 rounded-xl border bg-dark/50 border-white/5 hover:border-white/10 transition-all"
                    >
                      <span>{type.icon}</span>
                      <span className="text-sm">{type.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Prompt */}
              <div>
                <label className="block text-sm font-medium text-muted mb-2">What do you want to create about?</label>
                <div className="flex gap-3">
                  <input
                    type="text"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="e.g., Spring repair special, new service announcement, customer testimonial..."
                    className="input-field flex-1"
                  />
                  <button
                    onClick={handleGenerateContent}
                    disabled={generating || !prompt}
                    className="btn-primary flex items-center gap-2 disabled:opacity-50"
                  >
                    {generating ? (
                      <>
                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        Generating...
                      </>
                    ) : (
                      <>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                        </svg>
                        Generate
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Results */}
          {contentResults.length > 0 && (
            <div className="card">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold">Generated Content</h3>
                <span className="text-sm text-muted">{contentResults.length} variations</span>
              </div>

              <div className="space-y-4">
                {contentResults.map((result) => (
                  <div key={result.id} className="p-6 rounded-xl bg-dark/50 border border-white/5 hover:border-primary/30 transition-all group">
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                          result.engagement === 'high' 
                            ? 'bg-emerald-500/20 text-emerald-400' 
                            : 'bg-amber-500/20 text-amber-400'
                        }`}>
                          {result.engagement === 'high' ? '🔥 High Engagement' : '⚡ Medium Engagement'}
                        </span>
                        <span className="px-2 py-1 rounded-full bg-white/5 text-xs capitalize">{result.type}</span>
                      </div>
                    </div>
                    
                    <p className="text-sm mb-4 leading-relaxed">{result.content}</p>
                    
                    <div className="flex items-center justify-between">
                      <div className="flex flex-wrap gap-2">
                        {result.hashtags.map((tag) => (
                          <span key={tag} className="text-xs text-primary">{tag}</span>
                        ))}
                      </div>
                      <button
                        onClick={() => handleUseContent(result)}
                        className="btn-primary text-sm py-2 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        Use This Content
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* AI Suggestions from Profile */}
          <div className="card border-secondary/20">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-secondary flex items-center justify-center">
                <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </div>
              <div>
                <h3 className="font-bold">Smart Suggestions</h3>
                <p className="text-xs text-muted">Based on your business profile and AI learning</p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="p-4 rounded-xl bg-dark/50 cursor-pointer hover:bg-dark/70 transition-colors group">
                <div className="text-2xl mb-2">🎉</div>
                <h4 className="font-medium mb-1">Spring Special</h4>
                <p className="text-xs text-muted">Promotional content for seasonal offer</p>
                <button className="mt-3 text-xs text-primary opacity-0 group-hover:opacity-100 transition-opacity">Generate →</button>
              </div>
              <div className="p-4 rounded-xl bg-dark/50 cursor-pointer hover:bg-dark/70 transition-colors group">
                <div className="text-2xl mb-2">💡</div>
                <h4 className="font-medium mb-1">Tech Tips Series</h4>
                <p className="text-xs text-muted">Educational content for followers</p>
                <button className="mt-3 text-xs text-primary opacity-0 group-hover:opacity-100 transition-opacity">Generate →</button>
              </div>
              <div className="p-4 rounded-xl bg-dark/50 cursor-pointer hover:bg-dark/70 transition-colors group">
                <div className="text-2xl mb-2">⭐</div>
                <h4 className="font-medium mb-1">Customer Story</h4>
                <p className="text-xs text-muted">Testimonial-based content</p>
                <button className="mt-3 text-xs text-primary opacity-0 group-hover:opacity-100 transition-opacity">Generate →</button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Image Generator Input */}
          <div className="card">
            <h3 className="text-lg font-bold mb-4">Create Images</h3>
            
            <div className="space-y-4">
              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-muted mb-2">Describe your image</label>
                  <input
                    type="text"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="e.g., A technician repairing a smartphone in a modern workshop"
                    className="input-field w-full"
                  />
                </div>
                <div className="w-48">
                  <label className="block text-sm font-medium text-muted mb-2">Style</label>
                  <select className="input-field w-full">
                    <option value="photography">Photography</option>
                    <option value="illustration">Illustration</option>
                    <option value="digital-art">Digital Art</option>
                    <option value="3d">3D Render</option>
                  </select>
                </div>
              </div>

              <button
                onClick={handleGenerateImage}
                disabled={generating || !prompt}
                className="btn-primary flex items-center gap-2 disabled:opacity-50"
              >
                {generating ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Creating...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    Generate Image
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Generated Images */}
          {imageResults.length > 0 && (
            <div className="card">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold">Generated Images</h3>
                <span className="text-sm text-muted">Click to select</span>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {imageResults.map((result) => (
                  <div
                    key={result.id}
                    onClick={() => handleUseImage(result)}
                    className="relative rounded-xl overflow-hidden cursor-pointer group"
                  >
                    <img src={result.url} alt="" className="w-full h-64 object-cover" />
                    <div className="absolute inset-0 bg-gradient-to-t from-dark/90 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="absolute bottom-4 left-4 right-4">
                        <p className="text-sm mb-2">{result.prompt}</p>
                        <span className="text-xs px-2 py-1 rounded-full bg-white/20">{result.style}</span>
                      </div>
                    </div>
                    <button className="absolute top-4 right-4 w-10 h-10 rounded-full bg-primary flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                      <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Stock Library */}
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold">Stock Image Library</h3>
              <button className="text-sm text-primary hover:text-primary/80">Browse All →</button>
            </div>

            <div className="grid grid-cols-4 gap-4">
              {[
                'https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=400',
                'https://images.unsplash.com/photo-1593508512255-86ab42a8e620?w=400',
                'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400',
                'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=400',
              ].map((url, i) => (
                <div
                  key={i}
                  onClick={() => handleUseImage({ url })}
                  className="relative rounded-xl overflow-hidden cursor-pointer group aspect-square"
                >
                  <img src={url} alt="" className="w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-gradient-to-t from-dark/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                  <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="text-xs bg-white/20 px-2 py-1 rounded-lg">Select</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* AI Tips */}
      <div className="mt-8 p-6 rounded-2xl bg-gradient-to-r from-primary/10 to-secondary/10 border border-primary/20">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary to-secondary flex items-center justify-center flex-shrink-0">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <h3 className="font-bold text-lg mb-2">AI Pro Tips</h3>
            <ul className="space-y-2 text-sm text-muted">
              <li>• Be specific in your prompts for better results</li>
              <li>• Include your brand colors or style in image descriptions</li>
              <li>• Use educational content for higher engagement</li>
              <li>• AI learns from your choices - the more you use, the better it gets!</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}