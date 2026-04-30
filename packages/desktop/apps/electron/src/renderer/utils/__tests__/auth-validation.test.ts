/**
 * Tests for auth-validation utilities.
 *
 * These tests verify the shared authentication validation functions
 * used by both CredentialRequest and AuthRequestCard components.
 */
import { describe, it, expect } from 'bun:test'
import {
  validateBasicAuthCredentials,
  getPasswordValue,
  getPasswordLabel,
  getPasswordPlaceholder,
} from '../auth-validation'

// ============================================================================
// validateBasicAuthCredentials Tests
// ============================================================================

describe('validateBasicAuthCredentials', () => {
  describe('when passwordRequired is true (default)', () => {
    it('returns true when both username and password are provided', () => {
      expect(validateBasicAuthCredentials('user', 'pass', true)).toBe(true)
    })

    it('returns true when both fields have content with whitespace', () => {
      expect(validateBasicAuthCredentials('  user  ', '  pass  ', true)).toBe(true)
    })

    it('returns false when username is empty', () => {
      expect(validateBasicAuthCredentials('', 'pass', true)).toBe(false)
    })

    it('returns false when username is only whitespace', () => {
      expect(validateBasicAuthCredentials('   ', 'pass', true)).toBe(false)
    })

    it('returns false when password is empty', () => {
      expect(validateBasicAuthCredentials('user', '', true)).toBe(false)
    })

    it('returns false when password is only whitespace', () => {
      expect(validateBasicAuthCredentials('user', '   ', true)).toBe(false)
    })

    it('returns false when both fields are empty', () => {
      expect(validateBasicAuthCredentials('', '', true)).toBe(false)
    })

    it('defaults to passwordRequired=true when not specified', () => {
      expect(validateBasicAuthCredentials('user', '')).toBe(false)
      expect(validateBasicAuthCredentials('user', 'pass')).toBe(true)
    })
  })

  describe('when passwordRequired is false (optional password)', () => {
    it('returns true when only username is provided', () => {
      expect(validateBasicAuthCredentials('user', '', false)).toBe(true)
    })

    it('returns true when username is provided and password is whitespace', () => {
      expect(validateBasicAuthCredentials('user', '   ', false)).toBe(true)
    })

    it('returns true when both username and password are provided', () => {
      expect(validateBasicAuthCredentials('user', 'pass', false)).toBe(true)
    })

    it('returns false when username is empty', () => {
      expect(validateBasicAuthCredentials('', '', false)).toBe(false)
    })

    it('returns false when username is only whitespace', () => {
      expect(validateBasicAuthCredentials('   ', '', false)).toBe(false)
    })

    it('returns false when username is whitespace even with password', () => {
      expect(validateBasicAuthCredentials('   ', 'pass', false)).toBe(false)
    })
  })

  describe('backward compatibility', () => {
    // These tests ensure existing behavior for sources like Amplitude
    // that require both username and password

    it('Amplitude-style: requires both fields when passwordRequired not specified', () => {
      // Amplitude uses basic auth with both API key (username) and secret (password)
      expect(validateBasicAuthCredentials('api_key', 'secret')).toBe(true)
      expect(validateBasicAuthCredentials('api_key', '')).toBe(false)
    })

    // These tests ensure new behavior for sources like Ashby
    // that only require username (API key)

    it('Ashby-style: accepts empty password when passwordRequired=false', () => {
      // Ashby uses basic auth with only API key (username)
      expect(validateBasicAuthCredentials('api_key', '', false)).toBe(true)
    })
  })
})

// ============================================================================
// getPasswordValue Tests
// ============================================================================

describe('getPasswordValue', () => {
  describe('when passwordRequired is true (default)', () => {
    it('returns trimmed password', () => {
      expect(getPasswordValue('mypassword', true)).toBe('mypassword')
    })

    it('trims whitespace from password', () => {
      expect(getPasswordValue('  mypassword  ', true)).toBe('mypassword')
    })

    it('returns empty string for empty password', () => {
      expect(getPasswordValue('', true)).toBe('')
    })

    it('returns empty string for whitespace-only password', () => {
      expect(getPasswordValue('   ', true)).toBe('')
    })

    it('defaults to passwordRequired=true when not specified', () => {
      expect(getPasswordValue('pass')).toBe('pass')
    })
  })

  describe('when passwordRequired is false (optional password)', () => {
    it('returns empty string regardless of password content', () => {
      expect(getPasswordValue('mypassword', false)).toBe('')
    })

    it('returns empty string for whitespace password', () => {
      expect(getPasswordValue('   ', false)).toBe('')
    })

    it('returns empty string for empty password', () => {
      expect(getPasswordValue('', false)).toBe('')
    })
  })

  describe('security: prevents accidental credential leakage', () => {
    it('does not send auto-filled password when not required', () => {
      // Scenario: 1Password auto-fills a password, but it's optional
      const autoFilledPassword = 'secretFromPasswordManager'
      expect(getPasswordValue(autoFilledPassword, false)).toBe('')
    })

    it('does not send spaces entered by accident when not required', () => {
      // Scenario: User accidentally types spaces in password field
      expect(getPasswordValue('   ', false)).toBe('')
    })
  })
})

// ============================================================================
// getPasswordLabel Tests
// ============================================================================

describe('getPasswordLabel', () => {
  describe('when passwordRequired is true (default)', () => {
    it('returns the base label unchanged', () => {
      expect(getPasswordLabel('Password', true)).toBe('Password')
    })

    it('preserves custom labels', () => {
      expect(getPasswordLabel('Secret Key', true)).toBe('Secret Key')
    })

    it('defaults to passwordRequired=true when not specified', () => {
      expect(getPasswordLabel('Password')).toBe('Password')
    })
  })

  describe('when passwordRequired is false (optional password)', () => {
    it('appends (optional) suffix to label', () => {
      expect(getPasswordLabel('Password', false)).toBe('Password (optional)')
    })

    it('appends (optional) to custom labels', () => {
      expect(getPasswordLabel('Secret Key', false)).toBe('Secret Key (optional)')
    })

    it('handles empty base label', () => {
      expect(getPasswordLabel('', false)).toBe(' (optional)')
    })
  })
})

// ============================================================================
// getPasswordPlaceholder Tests
// ============================================================================

describe('getPasswordPlaceholder', () => {
  describe('when passwordRequired is true (default)', () => {
    it('returns "Enter {label}" placeholder', () => {
      expect(getPasswordPlaceholder('Password', true)).toBe('Enter password')
    })

    it('lowercases the label in placeholder', () => {
      expect(getPasswordPlaceholder('SECRET KEY', true)).toBe('Enter secret key')
    })

    it('defaults to passwordRequired=true when not specified', () => {
      expect(getPasswordPlaceholder('Password')).toBe('Enter password')
    })
  })

  describe('when passwordRequired is false (optional password)', () => {
    it('returns "Optional - leave blank" placeholder', () => {
      expect(getPasswordPlaceholder('Password', false)).toBe('Optional - leave blank')
    })

    it('ignores base label when optional', () => {
      // The placeholder is always the same when optional
      expect(getPasswordPlaceholder('Secret Key', false)).toBe('Optional - leave blank')
      expect(getPasswordPlaceholder('API Secret', false)).toBe('Optional - leave blank')
    })
  })
})

// ============================================================================
// Edge Cases and Integration Tests
// ============================================================================

describe('edge cases', () => {
  describe('special characters', () => {
    it('handles special characters in username', () => {
      expect(validateBasicAuthCredentials('user@example.com', 'pass', true)).toBe(true)
    })

    it('handles special characters in password', () => {
      expect(validateBasicAuthCredentials('user', 'p@$$w0rd!', true)).toBe(true)
    })

    it('handles unicode characters', () => {
      expect(validateBasicAuthCredentials('用户', '密码', true)).toBe(true)
    })

    it('handles newlines (should be trimmed)', () => {
      expect(validateBasicAuthCredentials('\nuser\n', '\npass\n', true)).toBe(true)
    })

    it('handles tabs (should be trimmed)', () => {
      expect(validateBasicAuthCredentials('\tuser\t', '\tpass\t', true)).toBe(true)
    })
  })

  describe('very long inputs', () => {
    it('handles long username', () => {
      const longUsername = 'a'.repeat(1000)
      expect(validateBasicAuthCredentials(longUsername, 'pass', true)).toBe(true)
    })

    it('handles long password', () => {
      const longPassword = 'b'.repeat(1000)
      expect(validateBasicAuthCredentials('user', longPassword, true)).toBe(true)
    })
  })

  describe('type coercion safety', () => {
    // These tests ensure the functions don't have unexpected behavior
    // with values that might be coerced

    it('handles string "false" as truthy password', () => {
      expect(validateBasicAuthCredentials('user', 'false', true)).toBe(true)
    })

    it('handles string "0" as truthy password', () => {
      expect(validateBasicAuthCredentials('user', '0', true)).toBe(true)
    })

    it('handles string "null" as truthy password', () => {
      expect(validateBasicAuthCredentials('user', 'null', true)).toBe(true)
    })

    it('handles string "undefined" as truthy password', () => {
      expect(validateBasicAuthCredentials('user', 'undefined', true)).toBe(true)
    })
  })
})

describe('integration: complete auth flow simulation', () => {
  /**
   * Simulate the complete flow for different auth scenarios
   */

  it('Amplitude flow: both fields required', () => {
    const passwordRequired = true
    const username = 'amplitude_api_key'
    const password = 'amplitude_secret'

    // Validation
    const isValid = validateBasicAuthCredentials(username, password, passwordRequired)
    expect(isValid).toBe(true)

    // Labels
    const label = getPasswordLabel('Secret Key', passwordRequired)
    expect(label).toBe('Secret Key')

    // Placeholder
    const placeholder = getPasswordPlaceholder('Secret Key', passwordRequired)
    expect(placeholder).toBe('Enter secret key')

    // Submit value
    const submitPassword = getPasswordValue(password, passwordRequired)
    expect(submitPassword).toBe('amplitude_secret')
  })

  it('Ashby flow: password optional', () => {
    const passwordRequired = false
    const username = 'ashby_api_key'
    const password = '' // User leaves blank

    // Validation should pass with just username
    const isValid = validateBasicAuthCredentials(username, password, passwordRequired)
    expect(isValid).toBe(true)

    // Labels
    const label = getPasswordLabel('Password', passwordRequired)
    expect(label).toBe('Password (optional)')

    // Placeholder
    const placeholder = getPasswordPlaceholder('Password', passwordRequired)
    expect(placeholder).toBe('Optional - leave blank')

    // Submit value should be empty string
    const submitPassword = getPasswordValue(password, passwordRequired)
    expect(submitPassword).toBe('')
  })

  it('Ashby flow: password auto-filled by manager but should be ignored', () => {
    const passwordRequired = false
    const username = 'ashby_api_key'
    const password = 'auto_filled_password_from_1password' // Password manager filled this

    // Validation should pass
    const isValid = validateBasicAuthCredentials(username, password, passwordRequired)
    expect(isValid).toBe(true)

    // Submit value should be empty string, not the auto-filled value!
    const submitPassword = getPasswordValue(password, passwordRequired)
    expect(submitPassword).toBe('')
  })
})
