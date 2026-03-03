# Homebrew Tap for Codi

## Setup Instructions

To enable `brew install` for Codi, create a separate repository:

### 1. Create the Tap Repository

Create a new GitHub repo named `homebrew-codi` under your account:

```bash
gh repo create gemdoq/homebrew-codi --public --description "Homebrew tap for Codi AI coding agent"
```

### 2. Add the Formula

Create `Formula/codi.rb` in that repo:

```ruby
class Codi < Formula
  desc "AI coding agent for your terminal"
  homepage "https://github.com/gemdoq/codi"
  url "https://registry.npmjs.org/codi-ai/-/codi-ai-0.1.0.tgz"
  license "MIT"

  depends_on "node@20"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec/"bin/codi"
  end

  test do
    assert_match "codi v", shell_output("#{bin}/codi --version")
  end
end
```

### 3. Users can then install with:

```bash
brew tap gemdoq/codi
brew install codi
```

### Important

- Update the `url` and version in the Formula each time you publish a new npm version
- The Formula URL points to the npm tarball, so npm publish must be done first
