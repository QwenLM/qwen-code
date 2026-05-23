import React, { useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AppProvider } from './context/AppContext'
import Sidebar from './components/Sidebar'
import ChatAssistant from './components/ChatAssistant'
import Dashboard from './pages/Dashboard'
import Compose from './pages/Compose'
import Calendar from './pages/Calendar'
import Analytics from './pages/Analytics'
import Accounts from './pages/Accounts'
import BusinessProfile from './pages/BusinessProfile'
import AIArena from './pages/AIArena'

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true)

  return (
    <AppProvider>
      <BrowserRouter>
        <div className="flex min-h-screen bg-gradient-radial noise">
          <Sidebar isOpen={sidebarOpen} toggle={() => setSidebarOpen(!sidebarOpen)} />
          
          <main className={`flex-1 transition-all duration-500 ${sidebarOpen ? 'ml-72' : 'ml-20'}`}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/compose" element={<Compose />} />
              <Route path="/calendar" element={<Calendar />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/accounts" element={<Accounts />} />
              <Route path="/business" element={<BusinessProfile />} />
              <Route path="/ai-arena" element={<AIArena />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>

          {/* Built-in AI Chat Assistant */}
          <ChatAssistant />
        </div>
      </BrowserRouter>
    </AppProvider>
  )
}

export default App