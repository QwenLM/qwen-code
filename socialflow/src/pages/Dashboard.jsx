import React from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '../context/AppContext'

export default function Dashboard() {
  const { state } = useApp()

  const stats = [
    { label: 'Total Followers', value: '20,900', change: '+12%', icon: 'users', color: 'primary' },
    { label: 'Posts This Week', value: '8', change: '+3', icon: 'post', color: 'secondary' },
    { label: 'Engagement Rate', value: '4.2%', change: '+0.8%', icon: 'heart', color: 'accent' },
    { label: 'AI Suggestions', value: '24', change: 'New', icon: 'sparkle', color: 'emerald' },
  ]

  const quickActions = [
    { label: 'Compose Post', icon: '✍️', path: '/compose', color: 'from-primary to-secondary' },
    { label: 'View Calendar', icon: '📅', path: '/calendar', color: 'from-secondary to-pink-500' },
    { label: 'AI Arena', icon: '🤖', path: '/ai-arena', color: 'from-accent to-orange-500' },
    { label: 'Analytics', icon: '📊', path: '/analytics', color: 'from-emerald to-teal-500' },
  ]

  const platformColors = {
    twitter: '#1DA1F2',
    facebook: '#4267B2',
    instagram: '#E4405F',
    linkedin: '#0A66C2'
  }

  return (
    <div className="p-8 animate-stagger">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-4xl font-bold mb-2">
          Welcome back, <span className="bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">Creator</span>
        </h1>
        <p className="text-muted text-lg">Here's what's happening with your social media today</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-6 mb-8">
        {stats.map((stat, i) => (
          <div key={i} className="card card-hover group">
            <div className="flex items-start justify-between mb-4">
              <div className={`w-12 h-12 rounded-xl bg-${stat.color}/10 flex items-center justify-center`}>
                {stat.icon === 'users' && (
                  <svg className="w-6 h-6 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                  </svg>
                )}
                {stat.icon === 'post' && (
                  <svg className="w-6 h-6 text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                )}
                {stat.icon === 'heart' && (
                  <svg className="w-6 h-6 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                  </svg>
                )}
                {stat.icon === 'sparkle' && (
                  <svg className="w-6 h-6 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                  </svg>
                )}
              </div>
              <span className={`text-sm font-medium ${stat.change.includes('+') ? 'text-emerald-400' : 'text-muted'}`}>
                {stat.change}
              </span>
            </div>
            <h3 className="text-3xl font-bold mb-1">{stat.value}</h3>
            <p className="text-muted text-sm">{stat.label}</p>
            <div className="mt-4 h-1 bg-white/5 rounded-full overflow-hidden">
              <div className={`h-full bg-gradient-to-r from-${stat.color} to-transparent rounded-full group-hover:w-full transition-all duration-500`} style={{ width: '60%' }} />
            </div>
          </div>
        ))}
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        {quickActions.map((action, i) => (
          <Link
            key={i}
            to={action.path}
            className="group relative overflow-hidden rounded-2xl p-6 bg-surface border border-white/5 hover:border-white/10 transition-all duration-300"
          >
            <div className={`absolute inset-0 bg-gradient-to-br ${action.color} opacity-0 group-hover:opacity-10 transition-opacity`} />
            <div className="text-4xl mb-3">{action.icon}</div>
            <h3 className="font-semibold group-hover:text-primary transition-colors">{action.label}</h3>
            <div className="absolute -bottom-2 -right-2 w-16 h-16 bg-gradient-to-br from-primary/20 to-transparent rounded-full blur-xl opacity-0 group-hover:opacity-100 transition-opacity" />
          </Link>
        ))}
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-3 gap-6">
        {/* Recent Posts */}
        <div className="col-span-2 card">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold">Recent Posts</h2>
            <Link to="/compose" className="text-primary hover:text-primary/80 text-sm font-medium transition-colors">
              View All →
            </Link>
          </div>
          <div className="space-y-4">
            {state.posts.slice(0, 3).map((post) => (
              <div key={post.id} className="flex items-start gap-4 p-4 rounded-xl bg-dark/50 border border-white/5 hover:border-primary/20 transition-all">
                {post.image && (
                  <img src={post.image} alt="" className="w-16 h-16 rounded-lg object-cover" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm mb-2 line-clamp-2">{post.content}</p>
                  <div className="flex items-center gap-4">
                    <div className="flex gap-1">
                      {post.platforms.map((platform) => (
                        <div
                          key={platform}
                          className="w-5 h-5 rounded-full flex items-center justify-center"
                          style={{ backgroundColor: platformColors[platform] + '20' }}
                        >
                          <span className="text-[8px]" style={{ color: platformColors[platform] }}>
                            {platform[0].toUpperCase()}
                          </span>
                        </div>
                      ))}
                    </div>
                    <span className={`text-xs px-2 py-1 rounded-full ${
                      post.status === 'posted' ? 'bg-emerald-500/20 text-emerald-400' :
                      post.status === 'scheduled' ? 'bg-primary/20 text-primary' :
                      'bg-muted/20 text-muted'
                    }`}>
                      {post.status}
                    </span>
                    {post.scheduledFor && (
                      <span className="text-xs text-muted">
                        {new Date(post.scheduledFor).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
                {post.stats && (
                  <div className="flex gap-3 text-xs">
                    <span className="text-muted">❤️ {post.stats.likes}</span>
                    <span className="text-muted">💬 {post.stats.comments}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* AI Insights */}
        <div className="card">
          <div className="flex items-center gap-2 mb-6">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-secondary flex items-center justify-center">
              <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
            </div>
            <h2 className="text-lg font-bold">AI Insights</h2>
          </div>

          <div className="space-y-4">
            <div className="p-4 rounded-xl bg-dark/50 border border-white/5">
              <p className="text-xs text-muted mb-2">Brand Voice</p>
              <p className="text-sm">"{state.aiLearned.brandVoice}"</p>
            </div>

            <div>
              <p className="text-xs text-muted mb-2">Top Topics</p>
              <div className="flex flex-wrap gap-2">
                {state.aiLearned.topTopics.map((topic) => (
                  <span key={topic} className="px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium">
                    {topic}
                  </span>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs text-muted mb-2">Best Posting Times</p>
              <div className="space-y-1">
                {state.aiLearned.bestPostingTimes.map((time) => (
                  <div key={time} className="flex items-center gap-2 text-sm">
                    <div className="w-2 h-2 rounded-full bg-accent" />
                    <span>{time}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <Link 
            to="/ai-arena" 
            className="mt-6 w-full btn-primary text-sm py-3 flex items-center justify-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            Explore AI Arena
          </Link>
        </div>
      </div>

      {/* Connected Accounts */}
      <div className="mt-6 card">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold">Connected Accounts</h2>
          <Link to="/accounts" className="text-primary hover:text-primary/80 text-sm font-medium transition-colors">
            Manage All →
          </Link>
        </div>
        <div className="grid grid-cols-4 gap-4">
          {state.accounts.map((account) => (
            <div
              key={account.id}
              className="relative p-4 rounded-xl bg-dark/50 border border-white/5 hover:border-white/10 transition-all group"
            >
              <div className="flex items-center gap-3 mb-3">
                <div 
                  className="w-10 h-10 rounded-xl flex items-center justify-center"
                  style={{ backgroundColor: account.color + '20' }}
                >
                  <span className="text-lg" style={{ color: account.color }}>
                    {account.platform === 'twitter' && '𝕏'}
                    {account.platform === 'facebook' && 'f'}
                    {account.platform === 'instagram' && '📷'}
                    {account.platform === 'linkedin' && 'in'}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{account.name}</p>
                  <p className="text-xs text-muted">{account.handle}</p>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted">
                  {account.connected ? `${account.followers.toLocaleString()} followers` : 'Not connected'}
                </span>
                <span className={`w-2 h-2 rounded-full ${account.connected ? 'bg-emerald-400' : 'bg-muted'}`} />
              </div>
              {account.connected && (
                <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}