import React, { useState } from 'react'
import { useApp } from '../context/AppContext'

export default function Analytics() {
  const { state } = useApp()
  const [timeRange, setTimeRange] = useState('7d')

  const stats = [
    { label: 'Total Impressions', value: '125.4K', change: '+18%', trend: 'up' },
    { label: 'Engagement Rate', value: '4.8%', change: '+0.6%', trend: 'up' },
    { label: 'New Followers', value: '892', change: '+12%', trend: 'up' },
    { label: 'Link Clicks', value: '456', change: '-3%', trend: 'down' },
  ]

  const platformStats = [
    { platform: 'Twitter', followers: '12.4K', engagement: '5.2%', posts: 24, color: '#1DA1F2' },
    { platform: 'Facebook', followers: '8.5K', engagement: '4.1%', posts: 18, color: '#4267B2' },
    { platform: 'Instagram', followers: '6.2K', engagement: '6.8%', posts: 12, color: '#E4405F' },
    { platform: 'LinkedIn', followers: '4.1K', engagement: '3.9%', posts: 8, color: '#0A66C2' },
  ]

  const topPosts = [
    { 
      content: 'Exciting news! We just upgraded our repair station with the latest diagnostic equipment...', 
      platform: 'twitter', 
      likes: 234, 
      comments: 45, 
      shares: 12,
      engagement: '8.2%'
    },
    { 
      content: 'Customer spotlight: Thanks to @sarah_tech for sharing her experience! We love...', 
      platform: 'instagram', 
      likes: 456, 
      comments: 67, 
      shares: 23,
      engagement: '9.1%'
    },
    { 
      content: '🚀 Weekend special: Get 20% off screen replacements this Saturday & Sunday!', 
      platform: 'facebook', 
      likes: 189, 
      comments: 34, 
      shares: 45,
      engagement: '7.4%'
    },
  ]

  const bestTimes = [
    { time: '9:00 AM - 11:00 AM', engagement: 'High', color: 'emerald' },
    { time: '12:00 PM - 1:00 PM', engagement: 'High', color: 'emerald' },
    { time: '6:00 PM - 8:00 PM', engagement: 'Medium', color: 'amber' },
    { time: '2:00 PM - 4:00 PM', engagement: 'Medium', color: 'amber' },
  ]

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-4xl font-bold mb-2">Analytics</h1>
          <p className="text-muted">Track your social media performance</p>
        </div>
        <div className="flex gap-2 p-1 bg-surface rounded-xl">
          {['24h', '7d', '30d', '90d'].map((range) => (
            <button
              key={range}
              onClick={() => setTimeRange(range)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                timeRange === range 
                  ? 'bg-primary text-white' 
                  : 'text-muted hover:text-white'
              }`}
            >
              {range}
            </button>
          ))}
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-6 mb-8">
        {stats.map((stat, i) => (
          <div key={i} className="card card-hover">
            <div className="flex items-start justify-between mb-4">
              <span className={`text-lg ${stat.trend === 'up' ? 'text-emerald-400' : 'text-red-400'}`}>
                {stat.trend === 'up' ? '↑' : '↓'}
              </span>
              <span className={`text-sm font-medium ${stat.change.includes('+') ? 'text-emerald-400' : 'text-red-400'}`}>
                {stat.change}
              </span>
            </div>
            <h3 className="text-3xl font-bold mb-1">{stat.value}</h3>
            <p className="text-muted text-sm">{stat.label}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Engagement Chart Placeholder */}
        <div className="col-span-2 card">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold">Engagement Overview</h2>
            <select className="bg-dark/50 border border-white/10 rounded-lg px-3 py-2 text-sm">
              <option>Last 7 days</option>
              <option>Last 30 days</option>
            </select>
          </div>
          
          {/* Simple Chart Visualization */}
          <div className="h-64 flex items-end gap-2">
            {[65, 45, 78, 52, 89, 67, 94].map((value, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-2">
                <div 
                  className="w-full bg-gradient-to-t from-primary to-secondary rounded-t-lg transition-all duration-500"
                  style={{ height: `${value}%` }}
                />
                <span className="text-xs text-muted">
                  {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i]}
                </span>
              </div>
            ))}
          </div>
          
          <div className="flex items-center justify-center gap-6 mt-6 pt-6 border-t border-white/5">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-primary" />
              <span className="text-sm text-muted">Likes</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-secondary" />
              <span className="text-sm text-muted">Comments</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-accent" />
              <span className="text-sm text-muted">Shares</span>
            </div>
          </div>
        </div>

        {/* Best Posting Times */}
        <div className="card">
          <h2 className="text-xl font-bold mb-6">Optimal Times</h2>
          <div className="space-y-3">
            {bestTimes.map((time, i) => (
              <div key={i} className="flex items-center gap-4 p-4 rounded-xl bg-dark/50 border border-white/5">
                <div className={`w-3 h-3 rounded-full bg-${time.color}-400`} />
                <div className="flex-1">
                  <p className="font-medium">{time.time}</p>
                  <p className="text-xs text-muted">Engagement: {time.engagement}</p>
                </div>
                <span className={`text-xs px-2 py-1 rounded-full ${
                  time.engagement === 'High' 
                    ? 'bg-emerald-500/20 text-emerald-400' 
                    : 'bg-amber-500/20 text-amber-400'
                }`}>
                  {time.engagement}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Platform Stats */}
      <div className="grid grid-cols-2 gap-6 mt-6">
        <div className="card">
          <h2 className="text-xl font-bold mb-6">Platform Performance</h2>
          <div className="space-y-4">
            {platformStats.map((platform, i) => (
              <div key={i} className="flex items-center gap-4">
                <div 
                  className="w-12 h-12 rounded-xl flex items-center justify-center"
                  style={{ backgroundColor: platform.color + '20' }}
                >
                  <span className="text-xl" style={{ color: platform.color }}>
                    {platform.platform[0]}
                  </span>
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium">{platform.platform}</span>
                    <span className="text-sm text-muted">{platform.followers} followers</span>
                  </div>
                  <div className="flex gap-4 text-xs text-muted">
                    <span>Engagement: {platform.engagement}</span>
                    <span>Posts: {platform.posts}</span>
                  </div>
                </div>
                <div className="w-24 h-2 bg-dark rounded-full overflow-hidden">
                  <div 
                    className="h-full rounded-full"
                    style={{ 
                      width: `${parseFloat(platform.engagement) * 15}%`,
                      backgroundColor: platform.color
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Top Performing Posts */}
        <div className="card">
          <h2 className="text-xl font-bold mb-6">Top Posts</h2>
          <div className="space-y-4">
            {topPosts.map((post, i) => (
              <div key={i} className="p-4 rounded-xl bg-dark/50 border border-white/5">
                <div className="flex items-start justify-between mb-3">
                  <p className="text-sm line-clamp-2 flex-1">{post.content}</p>
                  <span className="ml-4 text-sm font-medium text-primary">{post.engagement}</span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-muted">❤️ {post.likes}</span>
                  <span className="text-xs text-muted">💬 {post.comments}</span>
                  <span className="text-xs text-muted">🔄 {post.shares}</span>
                  <span className="text-xs px-2 py-1 rounded-full bg-white/5 capitalize">{post.platform}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* AI Recommendations */}
      <div className="card mt-6 border-primary/20">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-secondary flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
          </div>
          <h3 className="text-lg font-bold">AI Insights & Recommendations</h3>
        </div>
        
        <div className="grid grid-cols-3 gap-4">
          <div className="p-4 rounded-xl bg-dark/50">
            <p className="text-sm font-medium mb-2">📈 Increase posting frequency</p>
            <p className="text-xs text-muted">Posts with images get 2.3x more engagement. Consider adding visuals to your next 5 posts.</p>
          </div>
          <div className="p-4 rounded-xl bg-dark/50">
            <p className="text-sm font-medium mb-2">⏰ Optimal timing</p>
            <p className="text-xs text-muted">Your audience is most active between 9-11 AM. Schedule important posts during this window.</p>
          </div>
          <div className="p-4 rounded-xl bg-dark/50">
            <p className="text-sm font-medium mb-2">🎯 Content mix</p>
            <p className="text-xs text-muted">Educational content performs 40% better than promotional. Try a 70/30 split.</p>
          </div>
        </div>
      </div>
    </div>
  )
}