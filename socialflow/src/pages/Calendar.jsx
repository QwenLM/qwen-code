import React, { useState } from 'react'
import { useApp } from '../context/AppContext'

export default function Calendar() {
  const { state } = useApp()
  const [currentDate, setCurrentDate] = useState(new Date())
  const [selectedDate, setSelectedDate] = useState(null)

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  const year = currentDate.getFullYear()
  const month = currentDate.getMonth()

  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  const prevMonth = () => setCurrentDate(new Date(year, month - 1, 1))
  const nextMonth = () => setCurrentDate(new Date(year, month + 1, 1))

  const getPostsForDate = (day) => {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    return state.posts.filter(post => {
      if (!post.scheduledFor && post.status === 'posted') {
        const postedDate = new Date().toISOString().split('T')[0]
        return postedDate === dateStr
      }
      return post.scheduledFor?.split('T')[0] === dateStr
    })
  }

  const platformColors = {
    twitter: '#1DA1F2',
    facebook: '#4267B2',
    instagram: '#E4405F',
    linkedin: '#0A66C2'
  }

  const renderCalendar = () => {
    const days = []
    
    // Empty cells for days before the first day of the month
    for (let i = 0; i < firstDay; i++) {
      days.push(<div key={`empty-${i}`} className="h-24" />)
    }
    
    // Days of the month
    for (let day = 1; day <= daysInMonth; day++) {
      const posts = getPostsForDate(day)
      const isToday = day === new Date().getDate() && month === new Date().getMonth() && year === new Date().getFullYear()
      const isSelected = selectedDate === day

      days.push(
        <div
          key={day}
          onClick={() => setSelectedDate(day)}
          className={`h-24 p-2 rounded-xl border transition-all cursor-pointer ${
            isSelected 
              ? 'bg-primary/10 border-primary/50' 
              : isToday 
                ? 'bg-white/5 border-white/20' 
                : 'bg-dark/30 border-white/5 hover:border-white/10'
          }`}
        >
          <span className={`text-sm font-medium ${isToday ? 'text-primary' : 'text-muted'}`}>
            {day}
          </span>
          {posts.length > 0 && (
            <div className="flex gap-1 mt-1 flex-wrap">
              {posts.slice(0, 3).map((post, i) => (
                <div
                  key={i}
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: platformColors[post.platforms[0]] || '#6366F1' }}
                />
              ))}
              {posts.length > 3 && (
                <span className="text-[8px] text-muted">+{posts.length - 3}</span>
              )}
            </div>
          )}
        </div>
      )
    }
    
    return days
  }

  const selectedDatePosts = selectedDate ? getPostsForDate(selectedDate) : []

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-4xl font-bold mb-2">Content Calendar</h1>
          <p className="text-muted">Plan and visualize your posting schedule</p>
        </div>
        <div className="flex gap-3">
          <button className="btn-secondary flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-17.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
            Filter
          </button>
          <button className="btn-primary flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Post
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Calendar Grid */}
        <div className="col-span-2 card">
          {/* Month Navigation */}
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold">{monthNames[month]} {year}</h2>
            <div className="flex gap-2">
              <button
                onClick={prevMonth}
                className="p-2 rounded-lg hover:bg-white/5 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <button
                onClick={() => setCurrentDate(new Date())}
                className="px-4 py-2 rounded-lg bg-surface text-sm hover:bg-white/5 transition-colors"
              >
                Today
              </button>
              <button
                onClick={nextMonth}
                className="p-2 rounded-lg hover:bg-white/5 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>

          {/* Day Headers */}
          <div className="grid grid-cols-7 gap-2 mb-2">
            {dayNames.map(day => (
              <div key={day} className="text-center text-sm font-medium text-muted py-2">
                {day}
              </div>
            ))}
          </div>

          {/* Calendar Days */}
          <div className="grid grid-cols-7 gap-2">
            {renderCalendar()}
          </div>

          {/* Legend */}
          <div className="flex items-center gap-6 mt-6 pt-6 border-t border-white/5">
            {Object.entries(platformColors).map(([platform, color]) => (
              <div key={platform} className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
                <span className="text-xs text-muted capitalize">{platform}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Selected Date Details */}
        <div className="card">
          <h3 className="text-lg font-bold mb-4">
            {selectedDate 
              ? `${monthNames[month]} ${selectedDate}, ${year}`
              : 'Select a date'
            }
          </h3>

          {selectedDatePosts.length > 0 ? (
            <div className="space-y-4">
              {selectedDatePosts.map((post) => (
                <div key={post.id} className="p-4 rounded-xl bg-dark/50 border border-white/5">
                  {post.image && (
                    <img src={post.image} alt="" className="w-full h-32 object-cover rounded-lg mb-3" />
                  )}
                  <p className="text-sm mb-3 line-clamp-3">{post.content}</p>
                  <div className="flex items-center justify-between">
                    <div className="flex gap-1">
                      {post.platforms.map((platform) => (
                        <div
                          key={platform}
                          className="w-6 h-6 rounded-full flex items-center justify-center"
                          style={{ backgroundColor: platformColors[platform] + '20' }}
                        >
                          <span className="text-[10px]" style={{ color: platformColors[platform] }}>
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
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <div className="w-16 h-16 rounded-full bg-surface mx-auto mb-4 flex items-center justify-center">
                <svg className="w-8 h-8 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <p className="text-muted text-sm">No posts scheduled for this date</p>
              <button className="mt-4 btn-secondary text-sm">
                Create Post
              </button>
            </div>
          )}

          {/* Queue Preview */}
          <div className="mt-6 pt-6 border-t border-white/5">
            <h4 className="text-sm font-medium text-muted mb-3">Upcoming Queue</h4>
            <div className="space-y-2">
              {state.queue.map((item, i) => (
                <div key={item.id} className="flex items-center gap-3 p-3 rounded-xl bg-dark/30">
                  <div className="w-8 h-8 rounded-lg bg-surface flex items-center justify-center text-xs font-medium">
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{item.content}</p>
                    <p className="text-xs text-muted">
                      {new Date(item.nextPost).toLocaleString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}