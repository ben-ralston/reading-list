#!/bin/bash
# Initializes a new worktree with necessary environment setup.
set -eo pipefail

echo "🚀 Initializing worktree..."

# Check if pnpm is installed
if ! command -v pnpm &> /dev/null; then
    echo "❌ Error: pnpm is not installed."
    echo "   Install it with: npm install -g pnpm"
    exit 1
fi

# Check if vercel CLI is installed
if ! command -v vercel &> /dev/null; then
    echo "❌ Error: Vercel CLI is not installed."
    echo "   Install it with: npm install -g vercel"
    exit 1
fi

# Install dependencies using pnpm (matching packageManager in package.json)
echo "📦 Installing dependencies..."
pnpm install

# Link to Vercel project and pull environment variables.
# --scope is required: in non-interactive mode (e.g. the worktree pre-start hook)
# the Vercel CLI applies no default scope and exits with a missing_scope error.
VERCEL_SCOPE="${VERCEL_SCOPE:?Set VERCEL_SCOPE to your Vercel team or account slug}"
VERCEL_PROJECT="${VERCEL_PROJECT:?Set VERCEL_PROJECT to your Vercel project name}"
echo "🔗 Linking to Vercel project..."
vercel link -p "$VERCEL_PROJECT" -y --scope "$VERCEL_SCOPE"

echo "🔐 Pulling environment variables..."
vercel env pull --scope "$VERCEL_SCOPE"

# Verify required environment variables exist
if [ ! -f .env.local ]; then
    echo "❌ Error: .env.local file was not created."
    echo "   Vercel env pull may have failed."
    exit 1
fi

# Check for critical environment variables
if ! grep -q "SUPABASE_SERVICE_ROLE_KEY" .env.local; then
    echo "⚠️  Warning: SUPABASE_SERVICE_ROLE_KEY not found in .env.local"
fi

if ! grep -q "POSTGRES_URL" .env.local; then
    echo "⚠️  Warning: POSTGRES_URL not found in .env.local"
fi

# Build the project to ensure everything compiles
echo "🔨 Building project..."
pnpm run build

echo "✅ Worktree initialized successfully!"
echo ""
echo "Next steps:"
echo "  - Run './run dev' to start the development server (uses cloud DB)"
echo "  - For local database: './run db-start' then './run dev --local-db'"
echo "  - Run './run seed' to apply seed data to local database"
echo "  - Run './run studio' to open Supabase Studio in your browser"
