// Website Information Fetcher Service
// Fetches and analyzes business website content for AI-powered post creation

export async function fetchWebsiteInfo(url) {
  try {
    // Normalize URL
    let normalizedUrl = url.trim()
    if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
      normalizedUrl = 'https://' + normalizedUrl
    }

    // Validate URL
    try {
      new URL(normalizedUrl)
    } catch {
      throw new Error('Invalid URL format')
    }

    // Fetch website content
    const response = await fetch(`/api/fetch-website?url=${encodeURIComponent(normalizedUrl)}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      }
    })

    if (!response.ok) {
      throw new Error('Failed to fetch website')
    }

    const data = await response.json()
    return data
  } catch (error) {
    console.error('Website fetch error:', error)
    throw error
  }
}

// Simulated website content extraction (in production, use a backend proxy)
export async function extractWebsiteContent(url) {
  try {
    // Simulate fetching and analyzing website content
    // In production, this would call a backend API that uses puppeteer or similar
    
    const mockExtractedData = {
      businessName: extractBusinessName(url),
      description: extractDescription(url),
      services: extractServices(url),
      testimonials: extractTestimonials(url),
      promotions: extractPromotions(url),
      about: extractAbout(url),
      contact: extractContact(url),
      socialLinks: extractSocialLinks(url),
      keywords: extractKeywords(url),
      metaTags: {},
      images: [],
      lastUpdated: new Date().toISOString()
    }

    return mockExtractedData
  } catch (error) {
    console.error('Content extraction error:', error)
    throw error
  }
}

function extractBusinessName(url) {
  // Extract domain name as fallback business name
  try {
    const urlObj = new URL(url)
    const hostname = urlObj.hostname.replace('www.', '')
    const name = hostname.split('.')[0]
    // Convert kebab-case or camelCase to Title Case
    return name
      .replace(/-/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, l => l.toUpperCase())
  } catch {
    return 'Business'
  }
}

function extractDescription(url) {
  // Generate a description based on the URL
  return `Learn more about our products and services at ${url}`
}

function extractServices(url) {
  // Common service keywords to look for
  return [
    'Product Sales',
    'Customer Service',
    'Professional Support',
    'Quality Assurance'
  ]
}

function extractTestimonials(url) {
  return [
    'Great service and excellent quality!',
    'Highly recommended for everyone!',
    'Professional and reliable!'
  ]
}

function extractPromotions(url) {
  return [
    'Special offer available',
    'New customers welcome',
    'Quality guaranteed'
  ]
}

function extractAbout(url) {
  return `We are a dedicated team committed to providing excellent service and quality products. Our mission is to exceed customer expectations with every interaction.`
}

function extractContact(url) {
  return {
    email: 'contact@example.com',
    phone: '(555) 123-4567',
    address: '123 Business Street, City, State 12345'
  }
}

function extractSocialLinks(url) {
  return {
    facebook: null,
    twitter: null,
    instagram: null,
    linkedin: null
  }
}

function extractKeywords(url) {
  return ['business', 'services', 'quality', 'professional', 'customer']
}

// Analyze website content for AI insights
export function analyzeWebsiteContent(websiteData) {
  const insights = {
    tone: detectTone(websiteData.description),
    keyTopics: identifyKeyTopics(websiteData.services),
    targetAudience: inferTargetAudience(websiteData.keywords),
    contentStyle: determineContentStyle(websiteData),
    hashtags: generateHashtags(websiteData),
    ctaSuggestions: generateCTASuggestions(websiteData)
  }
  
  return insights
}

function detectTone(description) {
  const formalKeywords = ['professional', 'enterprise', 'corporate', 'business']
  const casualKeywords = ['friendly', 'fun', 'creative', 'artisan', 'craft']
  
  const lowerDesc = description.toLowerCase()
  
  if (formalKeywords.some(k => lowerDesc.includes(k))) {
    return 'professional'
  } else if (casualKeywords.some(k => lowerDesc.includes(k))) {
    return 'casual'
  }
  return 'balanced'
}

function identifyKeyTopics(services) {
  return services.map(s => s.split(' ')[0]).slice(0, 5)
}

function inferTargetAudience(keywords) {
  const audienceMap = {
    'tech': 'Tech-savvy individuals and businesses',
    'retail': 'Shoppers looking for deals and quality products',
    'service': 'Customers seeking professional assistance',
    'health': 'Health-conscious individuals',
    'food': 'Food lovers and culinary enthusiasts'
  }
  
  for (const [key, audience] of Object.entries(audienceMap)) {
    if (keywords.some(k => k.toLowerCase().includes(key))) {
      return audience
    }
  }
  
  return 'General audience interested in quality products and services'
}

function determineContentStyle(websiteData) {
  return {
    emoji: websiteData.description.length < 100,
    hashtags: true,
    callsToAction: true,
    storytelling: false,
    educational: true
  }
}

function generateHashtags(websiteData) {
  const baseHashtags = [
    '#Business',
    '#Services',
    '#Quality',
    '#CustomerFirst'
  ]
  
  const topicHashtags = websiteData.keywords.map(k => `#${k.charAt(0).toUpperCase() + k.slice(1)}`)
  
  return [...new Set([...baseHashtags, ...topicHashtags])].slice(0, 10)
}

function generateCTASuggestions(websiteData) {
  return [
    { text: 'Learn More', type: 'info' },
    { text: 'Contact Us', type: 'contact' },
    { text: 'Shop Now', type: 'conversion' },
    { text: 'Book Appointment', type: 'service' }
  ]
}

// Social Media Best Practices by Platform
export const socialMediaBestPractices = {
  twitter: {
    name: 'Twitter/X',
    color: '#1DA1F2',
    tips: [
      {
        title: 'Optimal Posting Times',
        content: 'Best times: 8-10 AM, 12-1 PM, 5-7 PM on weekdays',
        icon: '🕐'
      },
      {
        title: 'Character Limit Strategy',
        content: 'Keep posts under 280 characters. Use the full 280 for maximum engagement, but shorter tweets often perform better.',
        icon: '📝'
      },
      {
        title: 'Hashtag Strategy',
        content: 'Use 1-2 relevant hashtags. Research shows tweets with 1-2 hashtags get 2x more engagement.',
        icon: '#️⃣'
      },
      {
        title: 'Visual Content',
        content: 'Tweets with images get 3x more engagement. Always include relevant visuals when possible.',
        icon: '🖼️'
      },
      {
        title: 'Thread Usage',
        content: 'For complex topics, use threads (up to 25 tweets) to tell a complete story.',
        icon: '🧵'
      },
      {
        title: 'Timing Frequency',
        content: 'Post 3-5 times per day, but avoid over-posting. Quality over quantity.',
        icon: '📊'
      }
    ],
    doList: [
      'Reply to mentions and engage with followers',
      'Use trending hashtags when relevant',
      'Share behind-the-scenes content',
      'Ask questions to drive engagement',
      'Retweet relevant content from others'
    ],
    dontList: [
      "Don't ignore mentions and DMs",
      "Don't post too frequently (>10 times/day)",
      "Don't use more than 2-3 hashtags per tweet",
      "Don't be overly promotional constantly"
    ]
  },
  facebook: {
    name: 'Facebook',
    color: '#4267B2',
    tips: [
      {
        title: 'Optimal Posting Times',
        content: 'Best times: 1-4 PM on weekdays, especially Wednesday. Avoid posting after 8 PM.',
        icon: '🕐'
      },
      {
        title: 'Post Length',
        content: 'Ideal length is 40-80 characters for maximum engagement. Longer posts (500+ chars) get more comments.',
        icon: '📝'
      },
      {
        title: 'Visual First',
        content: 'Posts with images get 2x more engagement. Use videos for even higher reach.',
        icon: '🎥'
      },
      {
        title: 'Call to Action',
        content: 'Always include a CTA. "Comment below" or "Share with a friend" increases engagement.',
        icon: '📢'
      },
      {
        title: 'Engagement Tactics',
        content: 'Ask open-ended questions. Reply to all comments. Use Facebook Live for events.',
        icon: '💬'
      },
      {
        title: 'Post Frequency',
        content: '1-2 posts per day is ideal. More than 3 can lead to lower engagement rates.',
        icon: '📅'
      }
    ],
    doList: [
      'Share behind-the-scenes photos and videos',
      'Use Facebook Stories for daily updates',
      'Host Facebook Live sessions',
      'Create events and invite followers',
      'Use polls and questions'
    ],
    dontList: [
      "Don't auto-post the same content everywhere",
      "Don't use clickbait titles",
      "Don't neglect comments and messages",
      "Don't over-promote (keep it under 20% promotional)"
    ]
  },
  instagram: {
    name: 'Instagram',
    color: '#E4405F',
    tips: [
      {
        title: 'Optimal Posting Times',
        content: 'Best times: 11 AM-1 PM and 7-9 PM on weekdays. Tuesday-Thursday are best days.',
        icon: '🕐'
      },
      {
        title: 'Visual Quality',
        content: 'Use high-quality, well-lit images. Maintain consistent visual style and color palette.',
        icon: '📸'
      },
      {
        title: 'Caption Strategy',
        content: 'Write engaging captions up to 2,200 characters. First 125 characters matter most - hook the reader!',
        icon: '✍️'
      },
      {
        title: 'Hashtag Strategy',
        content: 'Use 8-15 relevant hashtags. Mix popular (1M+ posts) with niche (10K-100K posts).',
        icon: '#️⃣'
      },
      {
        title: 'Story Engagement',
        content: 'Post stories daily. Use stickers, polls, questions, and sliders for engagement.',
        icon: '📱'
      },
      {
        title: 'Reels & Video',
        content: 'Create Reels for algorithmic boost. 15-30 second videos perform best.',
        icon: '🎬'
      }
    ],
    doList: [
      'Use high-quality vertical images (4:5 ratio)',
      'Write compelling first line in caption',
      'Use 8-15 relevant hashtags per post',
      'Engage with other accounts daily',
      'Post Stories consistently'
    ],
    dontList: [
      "Don't use low-resolution images",
      "Don't post too many hashtags in comments (put in caption)",
      "Don't ignore DMs and comments",
      "Don't over-edit photos with heavy filters"
    ]
  },
  linkedin: {
    name: 'LinkedIn',
    color: '#0A66C2',
    tips: [
      {
        title: 'Optimal Posting Times',
        content: 'Best times: 7-8 AM, 12 PM, and 5-6 PM on weekdays. Tuesday-Thursday are best.',
        icon: '🕐'
      },
      {
        title: 'Professional Tone',
        content: 'Maintain professional yet authentic voice. Share industry insights and thought leadership.',
        icon: '💼'
      },
      {
        title: 'Post Length',
        content: '150-300 words is ideal for engagement. Include a clear takeaway or insight.',
        icon: '📝'
      },
      {
        title: 'Media Types',
        content: 'Documents get 3x more views. Use PDF carousels, infographics, and short videos.',
        icon: '📄'
      },
      {
        title: 'CTA Strategy',
        content: 'End with a question or call to action. "What are your thoughts?" drives comments.',
        icon: '💬'
      },
      {
        title: 'Post Frequency',
        content: '1 post per day is optimal. 3-5 per week is minimum for visibility.',
        icon: '📅'
      }
    ],
    doList: [
      'Share industry insights and expertise',
      'Write thought leadership articles',
      'Use professional, conversational tone',
      'Engage with comments within the first hour',
      'Tag relevant people and companies'
    ],
    dontList: [
      "Don't share purely promotional content",
      "Don't post generic motivational quotes",
      "Don't skip engaging with others content",
      "Don't use informal language or slang"
    ]
  }
}

// Ranking & SEO Tips for Social Media
export const socialMediaSEO = {
  algorithmTips: {
    twitter: [
      'Engagement signals (replies, likes, retweets) boost visibility',
      'Use trending topics when relevant for algorithmic boost',
      'Video content gets 3x more reach than text-only',
      'Reply to others to increase profile visits'
    ],
    facebook: [
      'Meaningful interactions matter more than reactions',
      'Native video gets priority in news feed',
      'Comments drive algorithmic reach more than likes',
      'Live videos get 6x more engagement than regular posts'
    ],
    instagram: [
      'Save actions are weighted heavily in algorithm',
      'Reels get major algorithmic push currently',
      'Consistent posting helps maintain reach',
      'Engagement within first hour is critical'
    ],
    linkedin: [
      'Professional expertise content ranks highest',
      'Document posts get more visibility than images',
      'Comments from first connections boost reach',
      'Early engagement (first 30 mins) is crucial'
    ]
  },
  growthStrategies: {
    twitter: [
      'Engage with trending conversations',
      'Retweet and comment on others content',
      'Use threads to share valuable insights',
      'Run polls to increase engagement'
    ],
    facebook: [
      'Build community through groups',
      'Cross-promote with complementary pages',
      'Use Facebook Live for real-time engagement',
      'Share user-generated content'
    ],
    instagram: [
      'Collaborate with micro-influencers',
      'Use Instagram Reels for discovery',
      'Engage with DMs and comments promptly',
      'Run contests and giveaways'
    ],
    linkedin: [
      'Publish articles consistently',
      'Comment on industry posts',
      'Share company updates and wins',
      'Connect with industry leaders'
    ]
  },
  analyticsMetrics: {
    twitter: ['Impressions', 'Engagement Rate', 'Link Clicks', 'Profile Visits', 'Follower Growth'],
    facebook: ['Reach', 'Engagement', 'Video Views', 'Page Likes', 'Click-Through Rate'],
    instagram: ['Reach', 'Saves', 'Shares', 'Profile Visits', 'Follower Growth'],
    linkedin: ['Impressions', 'Engagement Rate', 'Clicks', 'Leads', 'Follower Growth']
  }
}

// Content Calendar Suggestions
export function generateContentCalendar(platforms, websiteData) {
  const suggestions = []
  
  const contentTypes = [
    { day: 'Monday', type: 'Educational', icon: '💡', prompt: 'Share a helpful tip or how-to' },
    { day: 'Tuesday', type: 'Behind the Scenes', icon: '👀', prompt: 'Show your team or workspace' },
    { day: 'Wednesday', type: 'Promotional', icon: '🎉', prompt: 'Feature a product or service' },
    { day: 'Thursday', type: 'Engagement', icon: '💬', prompt: 'Ask a question or run a poll' },
    { day: 'Friday', type: 'Testimonial', icon: '⭐', prompt: 'Share customer success story' },
    { day: 'Saturday', type: 'Community', icon: '🤝', prompt: 'Engage with followers, reply to comments' },
    { day: 'Sunday', type: 'Inspiration', icon: '🌟', prompt: 'Share a motivational quote or story' }
  ]
  
  return contentTypes
}

export default {
  fetchWebsiteInfo,
  extractWebsiteContent,
  analyzeWebsiteContent,
  socialMediaBestPractices,
  socialMediaSEO,
  generateContentCalendar
}