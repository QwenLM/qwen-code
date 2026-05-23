import React, { useState } from 'react'
import { useApp } from '../context/AppContext'
import { socialMediaBestPractices, socialMediaSEO, analyzeWebsiteContent } from '../services/websiteService'

const industries = [
  'Repair Services',
  'Beauty & Salon',
  'Healthcare',
  'Real Estate',
  'Food & Restaurant',
  'Retail',
  'Professional Services',
  'Education',
  'Other'
]

export default function BusinessProfile() {
  const { state, dispatch } = useApp()
  const [isEditing, setIsEditing] = useState(false)
  const [websiteUrl, setWebsiteUrl] = useState('')
  const [isFetchingWebsite, setIsFetchingWebsite] = useState(false)
  const [websiteData, setWebsiteData] = useState(null)
  const [selectedTab, setSelectedTab] = useState('profile')
  const [formData, setFormData] = useState({
    name: state.business.name || 'TechFlow Studio',
    description: state.business.description || 'Professional device repair and tech services. Fast, reliable, and affordable solutions for all your tech needs.',
    industry: state.business.industry || 'Repair Services',
    services: state.business.services || ['Screen Replacement', 'Battery Repair', 'Data Recovery', 'Device Unlocking'],
    targetAudience: state.business.targetAudience || 'Tech-savvy individuals aged 25-45 who rely heavily on devices for work and personal use.',
    brandGuidelines: state.business.brandGuidelines || 'Professional yet friendly tone. Emphasize reliability, speed, and customer satisfaction.',
    newService: ''
  })

  const handleInputChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  const addService = () => {
    if (formData.newService.trim()) {
      setFormData(prev => ({
        ...prev,
        services: [...prev.services, formData.newService.trim()],
        newService: ''
      }))
    }
  }

  const removeService = (index) => {
    setFormData(prev => ({
      ...prev,
      services: prev.services.filter((_, i) => i !== index)
    }))
  }

  const handleSave = () => {
    dispatch({ type: 'UPDATE_BUSINESS', payload: formData })
    if (websiteData) {
      dispatch({ type: 'UPDATE_BUSINESS', payload: { websiteData } })
    }
    setIsEditing(false)
  }

  const handleFetchWebsite = async () => {
    if (!websiteUrl.trim()) return
    
    setIsFetchingWebsite(true)
    try {
      await new Promise(resolve => setTimeout(resolve, 1500))
      
      const mockWebsiteData = {
        url: websiteUrl,
        businessName: websiteUrl.replace(/(https?:\/\/)?(www\.)?/g, '').split('.')[0].replace(/-/g, ' '),
        description: `Welcome to our online presence! We offer premium services tailored to your needs.`,
        services: ['Service 1', 'Service 2', 'Service 3', 'Service 4'],
        testimonials: ['Great service!', 'Highly recommended!', 'Professional team!'],
        keywords: ['service', 'quality', 'professional', 'customer', 'business'],
        lastUpdated: new Date().toISOString()
      }
      
      setWebsiteData(mockWebsiteData)
      
      const insights = analyzeWebsiteContent(mockWebsiteData)
      dispatch({ type: 'UPDATE_BUSINESS', payload: { websiteUrl, websiteInsights: insights } })
      
    } catch (error) {
      console.error('Error fetching website:', error)
    } finally {
      setIsFetchingWebsite(false)
    }
  }

  const tabs = [
    { id: 'profile', label: 'Business Profile', icon: '🏢' },
    { id: 'website', label: 'Website Connection', icon: '🌐' },
    { id: 'practices', label: 'Best Practices', icon: '✅' },
    { id: 'ranking', label: 'Ranking Tips', icon: '📈' }
  ]

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-4xl font-bold mb-2">Business Profile</h1>
          <p className="text-muted">Manage your business info, website connection, and social media tips</p>
        </div>
        {!isEditing && (
          <button 
            onClick={() => setIsEditing(true)}
            className="btn-primary flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            Edit Profile
          </button>
        )}
        {isEditing && (
          <div className="flex gap-3">
            <button onClick={() => setIsEditing(false)} className="btn-secondary">Cancel</button>
            <button onClick={handleSave} className="btn-primary flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Save Changes
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6 border-b border-white/10 pb-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setSelectedTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-3 rounded-xl transition-all ${
              selectedTab === tab.id
                ? 'bg-primary/20 text-primary border border-primary/30'
                : 'text-muted hover:text-white hover:bg-white/5'
            }`}
          >
            <span>{tab.icon}</span>
            <span className="font-medium">{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="animate-fade-in">
        {selectedTab === 'profile' && (
          <div className="grid grid-cols-3 gap-6">
            <div className="col-span-2 space-y-6">
              <div className="card">
                <h2 className="text-lg font-bold mb-6">Basic Information</h2>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-muted mb-2">Business Name</label>
                    {isEditing ? (
                      <input type="text" value={formData.name} onChange={(e) => handleInputChange('name', e.target.value)} className="input-field w-full" />
                    ) : (
                      <p className="text-xl font-semibold">{state.business.name || formData.name}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-muted mb-2">Industry</label>
                    {isEditing ? (
                      <select value={formData.industry} onChange={(e) => handleInputChange('industry', e.target.value)} className="input-field w-full">
                        {industries.map((ind) => (
                          <option key={ind} value={ind}>{ind}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="px-3 py-1 rounded-full bg-primary/10 text-primary text-sm">{formData.industry}</span>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-muted mb-2">Description</label>
                    {isEditing ? (
                      <textarea value={formData.description} onChange={(e) => handleInputChange('description', e.target.value)} rows={3} className="input-field w-full resize-none" />
                    ) : (
                      <p className="text-muted">{formData.description}</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="card">
                <h2 className="text-lg font-bold mb-6">Services Offered</h2>
                <div className="flex flex-wrap gap-3 mb-4">
                  {formData.services.map((service, index) => (
                    <div key={index} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-surface border border-white/5">
                      <span>{service}</span>
                      {isEditing && (
                        <button onClick={() => removeService(index)} className="text-muted hover:text-red-400 transition-colors">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {isEditing && (
                  <div className="flex gap-2">
                    <input type="text" value={formData.newService} onChange={(e) => handleInputChange('newService', e.target.value)} onKeyPress={(e) => e.key === 'Enter' && addService()} placeholder="Add a service..." className="input-field flex-1" />
                    <button onClick={addService} className="btn-secondary">Add</button>
                  </div>
                )}
              </div>

              <div className="card">
                <h2 className="text-lg font-bold mb-6">Target Audience & Brand Guidelines</h2>
                {isEditing ? (
                  <>
                    <textarea value={formData.targetAudience} onChange={(e) => handleInputChange('targetAudience', e.target.value)} rows={3} placeholder="Describe your ideal customers..." className="input-field w-full resize-none mb-4" />
                    <textarea value={formData.brandGuidelines} onChange={(e) => handleInputChange('brandGuidelines', e.target.value)} rows={3} placeholder="Define your brand voice and style..." className="input-field w-full resize-none" />
                  </>
                ) : (
                  <>
                    <p className="text-muted mb-4">{formData.targetAudience}</p>
                    <p className="text-muted">{formData.brandGuidelines}</p>
                  </>
                )}
              </div>
            </div>

            <div className="space-y-6">
              <div className="card">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-secondary flex items-center justify-center">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                  </div>
                  <h3 className="font-bold">AI Learning</h3>
                </div>
                <div className="space-y-3">
                  <div className="p-4 rounded-xl bg-dark/50">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-muted">Profile Data</span>
                      <span className="text-xs text-emerald-400">✓ Complete</span>
                    </div>
                    <div className="h-2 bg-surface rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-400 rounded-full" style={{ width: '100%' }} />
                    </div>
                  </div>
                  <div className="p-4 rounded-xl bg-dark/50">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-muted">Post History Analysis</span>
                      <span className="text-xs text-emerald-400">✓ 47 posts</span>
                    </div>
                    <div className="h-2 bg-surface rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-400 rounded-full" style={{ width: '100%' }} />
                    </div>
                  </div>
                </div>
              </div>

              <div className="card">
                <h3 className="font-bold mb-4">What AI Has Learned</h3>
                <div className="space-y-4">
                  <div className="p-4 rounded-xl bg-dark/50">
                    <p className="text-xs text-muted mb-1">Brand Voice</p>
                    <p className="text-sm">"{state.aiLearned.brandVoice}"</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted mb-2">Top Topics</p>
                    <div className="flex flex-wrap gap-2">
                      {state.aiLearned.topTopics.map((topic) => (
                        <span key={topic} className="px-3 py-1 rounded-full bg-primary/10 text-primary text-xs">{topic}</span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {selectedTab === 'website' && (
          <div className="max-w-3xl">
            <div className="card">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-accent to-orange-500 flex items-center justify-center">
                  <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-xl font-bold">Website Connection</h2>
                  <p className="text-sm text-muted">Connect your business website to fetch information for better posts</p>
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex gap-3">
                  <input type="text" value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} placeholder="Enter your website URL (e.g., mybusiness.com)" className="input-field flex-1" />
                  <button onClick={handleFetchWebsite} disabled={!websiteUrl.trim() || isFetchingWebsite} className="btn-primary flex items-center gap-2 disabled:opacity-50">
                    {isFetchingWebsite ? (
                      <>
                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Fetching...
                      </>
                    ) : (
                      <>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                        </svg>
                        Fetch Info
                      </>
                    )}
                  </button>
                </div>

                {websiteData && (
                  <div className="p-6 rounded-xl bg-dark/50 border border-emerald-500/30 animate-slide-up">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-bold flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full bg-emerald-400" />
                        Website Connected
                      </h3>
                      <span className="text-xs text-muted">Last updated: Just now</span>
                    </div>
                    <div className="grid grid-cols-2 gap-4 mb-4">
                      <div className="p-4 rounded-xl bg-surface">
                        <p className="text-xs text-muted mb-1">Business Name</p>
                        <p className="font-medium">{websiteData.businessName}</p>
                      </div>
                      <div className="p-4 rounded-xl bg-surface">
                        <p className="text-xs text-muted mb-1">URL</p>
                        <p className="font-medium text-primary">{websiteData.url}</p>
                      </div>
                    </div>
                    <div className="mb-4">
                      <p className="text-xs text-muted mb-2">Detected Services</p>
                      <div className="flex flex-wrap gap-2">
                        {websiteData.services.map((service, i) => (
                          <span key={i} className="px-3 py-1 rounded-full bg-primary/10 text-primary text-xs">{service}</span>
                        ))}
                      </div>
                    </div>
                    <div className="mb-4">
                      <p className="text-xs text-muted mb-2">Keywords</p>
                      <div className="flex flex-wrap gap-2">
                        {websiteData.keywords.map((keyword, i) => (
                          <span key={i} className="px-2 py-1 rounded-full bg-secondary/10 text-secondary text-xs">#{keyword}</span>
                        ))}
                      </div>
                    </div>
                    <div className="p-4 rounded-xl bg-surface/50 border border-white/5">
                      <p className="text-xs text-muted mb-2">AI Insights</p>
                      <p className="text-sm">✓ Website content analyzed successfully</p>
                      <p className="text-sm">✓ Services and keywords extracted</p>
                      <p className="text-sm">✓ Ready to use in content generation</p>
                    </div>
                  </div>
                )}

                <div className="p-4 rounded-xl bg-surface/50 border border-white/5">
                  <h4 className="font-medium mb-2 flex items-center gap-2">
                    <span className="text-lg">💡</span>
                    Why connect your website?
                  </h4>
                  <ul className="space-y-2 text-sm text-muted">
                    <li>• Automatically extract your services and descriptions</li>
                    <li>• Pull testimonials and customer reviews</li>
                    <li>• Use real content for more authentic posts</li>
                    <li>• Save time by not manually entering info twice</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}

        {selectedTab === 'practices' && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-6">
              {Object.entries(socialMediaBestPractices).map(([platform, data]) => (
                <div key={platform} className="card">
                  <h3 className="text-lg font-bold mb-4 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: data.color + '20' }}>
                      <span className="text-xl" style={{ color: data.color }}>
                        {platform === 'twitter' && '𝕏'}
                        {platform === 'facebook' && 'f'}
                        {platform === 'instagram' && '📷'}
                        {platform === 'linkedin' && 'in'}
                      </span>
                    </div>
                    {data.name}
                  </h3>
                  <div className="space-y-4 mb-6">
                    {data.tips.map((tip, i) => (
                      <div key={i} className="p-4 rounded-xl bg-dark/50 border border-white/5">
                        <div className="flex items-start gap-3">
                          <span className="text-xl">{tip.icon}</span>
                          <div>
                            <h4 className="font-medium mb-1">{tip.title}</h4>
                            <p className="text-sm text-muted">{tip.content}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                      <h4 className="font-bold mb-3 flex items-center gap-2 text-emerald-400">
                        <span>✓</span> DO
                      </h4>
                      <ul className="space-y-2">
                        {data.doList.map((item, i) => (
                          <li key={i} className="flex items-center gap-2 text-sm">
                            <span className="text-emerald-400">•</span>
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20">
                      <h4 className="font-bold mb-3 flex items-center gap-2 text-red-400">
                        <span>✗</span> DON'T
                      </h4>
                      <ul className="space-y-2">
                        {data.dontList.map((item, i) => (
                          <li key={i} className="flex items-center gap-2 text-sm text-muted">
                            <span className="text-red-400">•</span>
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {selectedTab === 'ranking' && (
          <div className="space-y-6">
            <div className="card">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary to-secondary flex items-center justify-center">
                  <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-xl font-bold">Algorithm & Ranking Tips</h2>
                  <p className="text-sm text-muted">Understand how each platform's algorithm works</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-6">
                {Object.entries(socialMediaSEO.algorithmTips).map(([platform, tips]) => (
                  <div key={platform} className="p-6 rounded-xl bg-dark/50 border border-white/5">
                    <h3 className="font-bold mb-4 capitalize flex items-center gap-2">
                      <span className="text-xl">
                        {platform === 'twitter' && '𝕏'}
                        {platform === 'facebook' && 'f'}
                        {platform === 'instagram' && '📷'}
                        {platform === 'linkedin' && 'in'}
                      </span>
                      {platform}
                    </h3>
                    <ul className="space-y-3">
                      {tips.map((tip, i) => (
                        <li key={i} className="flex items-start gap-3 text-sm">
                          <span className="text-primary mt-1">▸</span>
                          <span className="text-muted">{tip}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center">
                  <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-xl font-bold">Growth Strategies</h2>
                  <p className="text-sm text-muted">Proven tactics to grow your audience</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-6">
                {Object.entries(socialMediaSEO.growthStrategies).map(([platform, strategies]) => (
                  <div key={platform} className="p-6 rounded-xl bg-dark/50 border border-white/5">
                    <h3 className="font-bold mb-4 capitalize">{platform}</h3>
                    <ul className="space-y-3">
                      {strategies.map((strategy, i) => (
                        <li key={i} className="flex items-start gap-3 text-sm">
                          <span className="text-emerald-400 mt-1">✓</span>
                          <span className="text-muted">{strategy}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>

            <div className="card border-accent/30">
              <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                <span className="text-2xl">📋</span>
                Quick Ranking Checklist
              </h3>
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <h4 className="font-medium text-emerald-400 mb-3">✓ Do These</h4>
                  <ul className="space-y-2">
                    <li className="flex items-center gap-2 text-sm"><input type="checkbox" className="w-4 h-4 rounded border-white/20 bg-dark" /> <span>Post consistently (3-5x/week)</span></li>
                    <li className="flex items-center gap-2 text-sm"><input type="checkbox" className="w-4 h-4 rounded border-white/20 bg-dark" /> <span>Use relevant hashtags (1-5 per post)</span></li>
                    <li className="flex items-center gap-2 text-sm"><input type="checkbox" className="w-4 h-4 rounded border-white/20 bg-dark" /> <span>Engage within first hour of posting</span></li>
                    <li className="flex items-center gap-2 text-sm"><input type="checkbox" className="w-4 h-4 rounded border-white/20 bg-dark" /> <span>Respond to all comments and DMs</span></li>
                    <li className="flex items-center gap-2 text-sm"><input type="checkbox" className="w-4 h-4 rounded border-white/20 bg-dark" /> <span>Include visuals (images/videos)</span></li>
                    <li className="flex items-center gap-2 text-sm"><input type="checkbox" className="w-4 h-4 rounded border-white/20 bg-dark" /> <span>Post at optimal times</span></li>
                  </ul>
                </div>
                <div>
                  <h4 className="font-medium text-red-400 mb-3">✗ Avoid These</h4>
                  <ul className="space-y-2">
                    <li className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" className="w-4 h-4 rounded border-white/20 bg-dark" /> <span>Spam posting (>10 posts/day)</span></li>
                    <li className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" className="w-4 h-4 rounded border-white/20 bg-dark" /> <span>Over-hashtagging (>10 per post)</span></li>
                    <li className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" className="w-4 h-4 rounded border-white/20 bg-dark" /> <span>Ignoring comments and messages</span></li>
                    <li className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" className="w-4 h-4 rounded border-white/20 bg-dark" /> <span>Posting low-quality images</span></li>
                    <li className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" className="w-4 h-4 rounded border-white/20 bg-dark" /> <span>Being overly promotional</span></li>
                    <li className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" className="w-4 h-4 rounded border-white/20 bg-dark" /> <span>Inconsistent posting schedule</span></li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}