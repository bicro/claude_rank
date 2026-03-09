#!/bin/bash

# Pre-commit check script for claude_rank
# Verifies code quality before pushing

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Status indicators
PASS="${GREEN}✓${NC}"
FAIL="${RED}✗${NC}"
WARN="${YELLOW}!${NC}"

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Pre-commit Check${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

cd src-tauri

# Track overall status
FAILED=0

# 1. Rust formatting (auto-fix)
echo -e "${BLUE}[1/4]${NC} Formatting Rust code..."
if cargo fmt 2>&1; then
    echo -e "  ${PASS} Code formatted"
else
    echo -e "  ${FAIL} Formatting failed"
    FAILED=1
fi

# 2. Rust build
echo -e "${BLUE}[2/4]${NC} Building project..."
if cargo build 2>&1; then
    echo -e "  ${PASS} Build succeeded"
else
    echo -e "  ${FAIL} Build failed"
    FAILED=1
fi

# 3. Rust linting with clippy
echo -e "${BLUE}[3/4]${NC} Running clippy..."
if cargo clippy -- -D warnings 2>&1; then
    echo -e "  ${PASS} Clippy passed"
else
    echo -e "  ${FAIL} Clippy found errors"
    FAILED=1
fi

cd ..

# 4. Sensitive files check
echo -e "${BLUE}[4/4]${NC} Checking for sensitive files..."
SENSITIVE_FILES=".api_key .env credentials.json secrets.json"
STAGED_SENSITIVE=""

for file in $SENSITIVE_FILES; do
    if git diff --cached --name-only 2>/dev/null | grep -q "$file"; then
        STAGED_SENSITIVE="$STAGED_SENSITIVE $file"
    fi
done

if [ -n "$STAGED_SENSITIVE" ]; then
    echo -e "  ${FAIL} Sensitive files staged for commit:${STAGED_SENSITIVE}"
    FAILED=1
else
    echo -e "  ${PASS} No sensitive files staged"
fi

# Summary
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}  All checks passed! Ready to commit.${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    exit 0
else
    echo -e "${RED}  Some checks failed. Please fix before committing.${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    exit 1
fi
