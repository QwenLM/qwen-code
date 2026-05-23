import React, { useState } from 'react'
import { useApp } from '../context/AppContext'

const platforms = [
  { 
    id: 'twitter', 
    name: 'Twitter/X', 
    color: '#1DA1F2', 
    icon: '𝕏',
    description: 'Connect your Twitter or X account to post tweets and engage with your audience.',
    scopes: ['Tweet', 'Media Upload', 'Analytics']
  },
  { 
    id: 'facebook', 
    name: 'Facebook', 
    color: '#4267B2', 
    icon: 'f',
    description: 'Connect your Facebook Page to post updates and manage your social presence.',
    scopes: ['Publish', 'Manage Pages', 'Analytics']
  },
  { 
    id: 'instagram', 
    name: 'Instagram', 
    color: '#E4405F', 
    icon: '📷',
    description: 'Connect your Instagram Business account for posts, stories, and reels.',
    scopes: ['Content Publishing', 'Insights', 'Messaging']
  },
  { 
    id: 'linkedin', 
    name: 'LinkedIn', 
    color: '#0A66C2', 
    icon: 'in',
    description: 'Connect your LinkedIn Company Page to share professional updates and articles.',
    scopes: ['Share', 'Company Pages', 'Analytics']
  },
  { 
    id: 'tiktok', 
    name: 'TikTok', 
    color: '#000000', 
    icon: '♪',
    description: 'Connect your TikTok Business account for short-form video content.',
    scopes: ['Video Upload', 'Analytics']
  },
  { 
    id: 'pinterest', 
    name: 'Pinterest', 
    color: '#E60023', 
    icon: 'P',
    description: 'Connect your Pinterest Business account for visual discovery and pins.',
    scopes: ['Create Pins', 'Boards', 'Analytics']
  }
]

export default function Accounts() {
  const { state, dispatch } = useApp()
  const [showConnectModal, setShowConnectModal] = useState(false)
  const [showApiKeyModal, setShowApiKeyModal] = useState(false)
  const [selectedPlatform, setSelectedPlatform] = useState(null)
  const [apiKeyForm, setApiKeyForm] = useState({ accessToken: '', appId: '', appSecret: '' })

  const handleOAuthConnect = (platformId) => {
    // Simulate OAuth flow
    const newAccount = {
      id: Date.now().toString(),
      platform: platformId,
      name: 'My Business Page',
      handle: '@mybusiness',
      connected: true,
      followers: Math.floor(Math.random() * 10000),
      color: platforms.find(p => p.id === platformId)?.color
    }
    dispatch({ type: 'ADD_ACCOUNT', payload: newAccount })
    setShowConnectModal(false)
  }

  const handleApiKeySubmit = () => {
    if (!selectedPlatform) return
    const newAccount = {
      id: Date.now().toString(),
      platform: selectedPlatform.id,
      name: `${selectedPlatform.name} (API)`,
      handle: '@api_connected',
      connected: true,
      followers: 0,
      color: selectedPlatform.color
    }
    dispatch({ type: 'ADD_ACCOUNT', payload: newAccount })
    setShowApiKeyModal(false)
    setApiKeyForm({ accessToken: '', appId: '', appSecret: '' })
  }

  const handleDisconnect = (accountId) => {
    dispatch({ type: 'UPDATE_ACCOUNT', payload: { id: accountId, connected: false } })
  }

  const handleReconnect = (accountId) => {
    dispatch({ type: 'UPDATE_ACCOUNT', payload: { id: accountId, connected: true, followers: Math.floor(Math.random() * 10000) } })
  }

  const handleRemove = (accountId) => {
    dispatch({ type: 'REMOVE_ACCOUNT', payload: accountId })
  }

  const connectedAccounts = state.accounts.filter(a => a.connected)
  const disconnectedAccounts = state.accounts.filter(a => !a.connected)

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-4xl font-bold mb-2">Connected Accounts</h1>
          <p className="text-muted">Manage your social media connections</p>
        </div>
        <div className="flex gap-3">
          <button 
            onClick={() => { setSelectedPlatform(null); setShowApiKeyModal(true) }}
            className="btn-secondary flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
            Add via API Key
          </button>
          <button 
            onClick={() => setShowConnectModal(true)}
            className="btn-primary flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Connect Account
          </button>
        </div>
      </div>

      {/* Connected Accounts */}
      {connectedAccounts.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-emerald-400" />
            Connected ({connectedAccounts.length})
          </h2>
          <div className="grid grid-cols-2 gap-4">
            {connectedAccounts.map((account) => {
              const platform = platforms.find(p => p.id === account.platform)
              return (
                <div key={account.id} className="card card-hover">
                  <div className="flex items-start gap-4">
                    <div 
                      className="w-14 h-14 rounded-xl flex items-center justify-center"
                      style={{ backgroundColor: platform?.color + '20' }}
                    >
                      <span className="text-2xl" style={{ color: platform?.color }}>
                        {platform?.icon}
                      </span>
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <h3 className="font-semibold">{account.name}</h3>
                          <p className="text-sm text-muted">{account.handle}</p>
                        </div>
                        <span className="px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-medium">
                          Connected
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-sm text-muted mb-4">
                        <span>{platform?.name}</span>
                        {account.followers > 0 && (
                          <span>• {account.followers.toLocaleString()} followers</span>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <button 
                          onClick={() => handleDisconnect(account.id)}
                          className="px-4 py-2 rounded-lg bg-surface text-sm hover:bg-white/10 transition-colors"
                        >
                          Disconnect
                        </button>
                        <button 
                          onClick={() => handleRemove(account.id)}
                          className="px-4 py-2 rounded-lg bg-red-500/10 text-red-400 text-sm hover:bg-red-500/20 transition-colors"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Disconnected Accounts */}
      {disconnectedAccounts.length > 0 && (
        <div>
          <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-muted" />
            Disconnected ({disconnectedAccounts.length})
          </h2>
          <div className="grid grid-cols-2 gap-4">
            {disconnectedAccounts.map((account) => {
              const platform = platforms.find(p => p.id === account.platform)
              return (
                <div key={account.id} className="card opacity-60">
                  <div className="flex items-start gap-4">
                    <div 
                      className="w-14 h-14 rounded-xl flex items-center justify-center bg-dark"
                    >
                      <span className="text-2xl text-muted">{platform?.icon}</span>
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <h3 className="font-semibold">{account.name}</h3>
                          <p className="text-sm text-muted">{account.handle}</p>
                        </div>
                        <span className="px-3 py-1 rounded-full bg-muted/20 text-muted text-xs font-medium">
                          Disconnected
                        </span>
                      </div>
                      <div className="flex gap-2">
                        <button 
                          onClick={() => handleReconnect(account.id)}
                          className="px-4 py-2 rounded-lg bg-primary/20 text-primary text-sm hover:bg-primary/30 transition-colors"
                        >
                          Reconnect
                        </button>
                        <button 
                          onClick={() => handleRemove(account.id)}
                          className="px-4 py-2 rounded-lg bg-red-500/10 text-red-400 text-sm hover:bg-red-500/20 transition-colors"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* OAuth Connect Modal */}
      {showConnectModal && (
        <div className="fixed inset-0 bg-dark/80 backdrop-blur-sm z-50 flex items-center justify-center p-8">
          <div className="card max-w-2xl w-full max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-bold">Connect Account</h2>
              <button 
                onClick={() => setShowConnectModal(false)}
                className="p-2 rounded-lg hover:bg-white/5 transition-colors"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <p className="text-muted mb-6">Select a platform to connect via OAuth</p>

            <div className="grid grid-cols-2 gap-4">
              {platforms.map((platform) => {
                const isConnected = state.accounts.some(a => a.platform === platform.id && a.connected)
                return (
                  <button
                    key={platform.id}
                    onClick={() => !isConnected && handleOAuthConnect(platform.id)}
                    disabled={isConnected}
                    className={`p-6 rounded-xl border transition-all text-left ${
                      isConnected
                        ? 'bg-emerald-500/5 border-emerald-500/20 opacity-60'
                        : 'bg-dark/50 border-white/5 hover:border-primary/30 hover:bg-white/5'
                    }`}
                  >
                    <div className="flex items-center gap-4 mb-3">
                      <div 
                        className="w-12 h-12 rounded-xl flex items-center justify-center"
                        style={{ backgroundColor: platform.color + '20' }}
                      >
                        <span className="text-2xl" style={{ color: platform.color }}>
                          {platform.icon}
                        </span>
                      </div>
                      <div>
                        <h3 className="font-semibold">{platform.name}</h3>
                        {isConnected && (
                          <span className="text-xs text-emerald-400">✓ Connected</span>
                        )}
                      </div>
                    </div>
                    <p className="text-sm text-muted mb-3">{platform.description}</p>
                    <div className="flex flex-wrap gap-2">
                      {platform.scopes.map((scope) => (
                        <span key={scope} className="px-2 py-1 rounded-full bg-white/5 text-xs">
                          {scope}
                        </span>
                      ))}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* API Key Modal */}
      {showApiKeyModal && (
        <div className="fixed inset-0 bg-dark/80 backdrop-blur-sm z-50 flex items-center justify-center p-8">
          <div className="card max-w-lg w-full">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-bold">Add via API Key</h2>
              <button 
                onClick={() => setShowApiKeyModal(false)}
                className="p-2 rounded-lg hover:bg-white/5 transition-colors"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Platform</label>
                <select 
                  className="input-field w-full"
                  value={selectedPlatform?.id || ''}
                  onChange={(e) => setSelectedPlatform(platforms.find(p => p.id === e.target.value))}
                >
                  <option value="">Select platform...</option>
                  {platforms.map((platform) => (
                    <option key={platform.id} value={platform.id}>{platform.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Access Token</label>
                <input
                  type="password"
                  value={apiKeyForm.accessToken}
                  onChange={(e) => setApiKeyForm({ ...apiKeyForm, accessToken: e.target.value })}
                  placeholder="Enter your access token"
                  className="input-field w-full"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-2">App ID (optional)</label>
                  <input
                    type="text"
                    value={apiKeyForm.appId}
                    onChange={(e) => setApiKeyForm({ ...apiKeyForm, appId: e.target.value })}
                    placeholder="App ID"
                    className="input-field w-full"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">App Secret (optional)</label>
                  <input
                    type="password"
                    value={apiKeyForm.appSecret}
                    onChange={(e) => setApiKeyForm({ ...apiKeyForm, appSecret: e.target.value })}
                    placeholder="App Secret"
                    className="input-field w-full"
                  />
                </div>
              </div>

              <div className="p-4 rounded-xl bg-surface/50 border border-white/5 text-sm">
                <p className="text-muted">
                  <strong>Note:</strong> API keys are encrypted and stored securely. They allow multiple team members to use the same account without logging in individually.
                </p>
              </div>

              <button 
                onClick={handleApiKeySubmit}
                disabled={!selectedPlatform || !apiKeyForm.accessToken}
                className="w-full btn-primary py-3 disabled:opacity-50"
              >
                Add Account
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}