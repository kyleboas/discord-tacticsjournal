# Discord TacticsJournal Bot - Product Roadmap

**Last Updated:** 2025-11-15
**Project Manager:** Claude
**Version:** 1.0

---

## Executive Summary

TacticsJournal is a production-ready football community Discord bot with sophisticated features including player watchlists, automated daily quizzes, match reminders, and AI-powered moderation. This roadmap outlines strategic improvements across four quarters to enhance functionality, user engagement, and maintainability.

---

## Current State Assessment

### Strengths
- **Robust Core Features**: Watchlist, quiz, and fixture systems are well-implemented
- **AI Integration**: Automated content generation and moderation
- **Multi-league Support**: 33 leagues with team following capabilities
- **Persistent State**: Database-backed with proper error handling
- **Production-Ready**: Role-based permissions, connection pooling, caching strategies

### Technical Debt
- Duplicate event handlers in index.js
- Hardcoded channel/role IDs (not environment variables)
- Unused dependencies (ioredis, main.py)
- Legacy files (JSON watchlists superseded by PostgreSQL)
- Starred matches feature incomplete
- Manual reminders not preserved during fixture updates

---

## Roadmap Timeline

### Q1 2025: Foundation & Technical Debt (Months 1-3)

**Theme:** Stabilization and Code Quality

#### Priority 1: Critical Fixes
- [ ] **Remove duplicate `ready` event handlers** (index.js lines 76-104, 297-318)
- [ ] **Audit and remove unused dependencies** (ioredis, main.py, legacy JSON files)
- [ ] **Fix manual reminder preservation** in fixture updates
- [ ] **Comprehensive error logging system** with categorization

#### Priority 2: Configuration Improvements
- [ ] **Extract hardcoded IDs to environment variables**
  - Role IDs (Members, Admin, Quiz, Moderator)
  - Channel IDs (current hardcoded channels)
  - Create `.env.template` with all required variables
- [ ] **Per-guild role configuration system**
  - Allow each server to set their own admin/quiz/member roles
  - Store in `guild_settings` table
- [ ] **Configuration validation on startup**
  - Check for missing environment variables
  - Validate database connection before bot goes online

#### Priority 3: Documentation
- [ ] **Comprehensive README.md**
  - Installation guide
  - Configuration steps
  - Command reference with examples
  - Architecture overview
- [ ] **Developer documentation**
  - Database schema diagrams
  - API integration guides
  - Contributing guidelines
- [ ] **Admin guide**
  - Setup walkthrough
  - Role configuration best practices
  - Troubleshooting common issues

**Success Metrics:**
- Zero duplicate code blocks
- All configuration externalized
- 100% documentation coverage for commands
- Clean dependency tree

---

### Q2 2025: User Experience Enhancement (Months 4-6)

**Theme:** Polish and Engagement

#### Priority 1: Enhanced Watchlist Features
- [ ] **Watchlist notifications**
  - Notify when players on your watchlist score/assist
  - Integrate with football-data.org live match API
  - Configurable notification preferences per user
- [ ] **Player statistics display**
  - Show recent form, goals, assists when viewing watchlist
  - Cache player stats to reduce API calls
- [ ] **Watchlist comparisons**
  - Compare your watchlist with other users
  - "Most popular" players tracked across server
- [ ] **Export watchlist to CSV/JSON**
  - Allow users to download their data
  - Admin export for entire server watchlist

#### Priority 2: Quiz System Improvements
- [ ] **Quiz difficulty levels**
  - Easy (5 points), Medium (10 points), Hard (15 points)
  - Difficulty-based leaderboards
- [ ] **Quiz categories**
  - Tactical questions, historical trivia, current events
  - Allow users to vote on next day's category
- [ ] **Quiz streaks system**
  - Track consecutive days participating
  - Bonus points for streak milestones (7, 30, 100 days)
  - Streak leaderboard
- [ ] **Question submission system**
  - Users can submit questions for review
  - Moderator approval workflow
  - Credit to question authors
- [ ] **Quiz history**
  - `/quiz history` - Review past questions and answers
  - See which questions you got right/wrong

#### Priority 3: Match Reminder Enhancements
- [ ] **Match predictions system**
  - Users predict score before kickoff
  - Points awarded for accuracy
  - Prediction leaderboard
- [ ] **Match thread creation**
  - Auto-create thread for each match
  - Post lineups, stats, live updates
- [ ] **Live score updates**
  - Post goal notifications in real-time
  - Final score announcements with thread summary
- [ ] **Match highlights integration**
  - Fetch and post highlight videos after matches
  - Integration with YouTube API or third-party services

**Success Metrics:**
- 50% increase in daily quiz participation
- 30% of users create watchlists
- Average 10+ users per match prediction

---

### Q3 2025: Analytics & Community Features (Months 7-9)

**Theme:** Data-Driven Insights and Social Features

#### Priority 1: Analytics Dashboard
- [ ] **Server statistics command** (`/stats server`)
  - Total users, active users (30 days)
  - Most followed teams
  - Quiz participation rates
  - Watchlist engagement metrics
- [ ] **Personal statistics** (`/stats me`)
  - Your quiz performance over time
  - Watchlist activity
  - Match prediction accuracy
  - Participation badges/achievements
- [ ] **Admin analytics** (`/admin analytics`)
  - Peak activity times
  - Command usage frequency
  - User retention metrics
  - Export to CSV for external analysis

#### Priority 2: Achievements System
- [ ] **Badge framework**
  - Database schema for user achievements
  - Badge display on profiles
- [ ] **Achievement categories**
  - **Quiz Master**: Various quiz milestones
  - **Scout**: Watchlist-based achievements
  - **Oracle**: Prediction accuracy badges
  - **Loyal Fan**: Participation and streak badges
- [ ] **Showcase achievements** (`/profile`)
  - Display user's top badges
  - Total points across all systems
  - Join date and activity level

#### Priority 3: Social Features
- [ ] **User profiles** (`/profile @user`)
  - View another user's stats and achievements
  - Public watchlist preview
  - Quiz rank and prediction record
- [ ] **Leaderboard improvements**
  - Paginated leaderboards with navigation buttons
  - Filter by time period (daily, weekly, monthly, all-time)
  - Multiple leaderboard types (quiz, predictions, watchlist activity)
- [ ] **Rivalry system**
  - Challenge another user to quiz/prediction battles
  - Weekly rivalry matchups
  - Rivalry leaderboard

#### Priority 4: Complete Starred Matches Feature
- [ ] **Implement `/match star` command**
  - Star matches for personal reminders
  - View your starred matches
- [ ] **Starred match notifications**
  - DM reminders for starred matches
  - Option to get extra updates for starred matches only

**Success Metrics:**
- 70% of active users earn at least one achievement
- 25% of users view profiles weekly
- 40% increase in user-to-user interaction

---

### Q4 2025: Advanced Features & Integrations (Months 10-12)

**Theme:** Innovation and Ecosystem Expansion

#### Priority 1: Fantasy League Integration
- [ ] **Mini fantasy system**
  - Create fantasy teams from watchlist players
  - Point system based on real performance
  - Weekly fantasy leagues within Discord
- [ ] **Fantasy leaderboards**
  - Weekly winners with role rewards
  - Season-long championship
- [ ] **Integration with FPL API**
  - Import Fantasy Premier League teams
  - Compare FPL ranks within Discord
  - Automated gameweek reminders

#### Priority 2: Tactical Discussion Tools
- [ ] **Formation builder** (`/tactics formation`)
  - Interactive formation creation (4-4-2, 4-3-3, etc.)
  - Visual representation using emojis/images
  - Share and save formations
- [ ] **Tactical board**
  - Create simple tactical diagrams
  - Export as images
  - Library of common tactical patterns
- [ ] **Match analysis templates**
  - Structured post-match analysis format
  - Voting/reaction system for best analysis
  - Analysis of the week showcase

#### Priority 3: Enhanced Moderation
- [ ] **Spam detection**
  - Rate limiting on messages
  - Auto-mute for rapid posting
  - Configurable thresholds
- [ ] **Moderation dashboard** (`/mod dashboard`)
  - Recent strikes overview
  - User strike history lookup
  - Appeal system for strikes
- [ ] **Auto-mod configuration** (`/mod config`)
  - Toggle moderation features per guild
  - Customize strike thresholds
  - Whitelist trusted users
- [ ] **Moderation logs**
  - Dedicated logging channel
  - All mod actions recorded with context
  - Export logs for review

#### Priority 4: External Integrations
- [ ] **Transfer news aggregator**
  - Fetch from reliable sources (BBC, Sky Sports, The Athletic)
  - Filter by followed teams
  - Daily transfer roundup
- [ ] **Reddit integration**
  - Post popular content from r/soccer
  - Filter by flair and upvotes
  - Daily highlights thread
- [ ] **Twitch/YouTube alerts**
  - Notify when followed content creators go live
  - Football-related streams and videos
- [ ] **News feed system**
  - Aggregated football news
  - Customizable sources
  - Breaking news alerts for followed teams

#### Priority 5: Mobile/Web Companion
- [ ] **Web dashboard** (Stretch goal)
  - View leaderboards on web
  - Manage watchlist from browser
  - Quiz history and stats visualization
- [ ] **REST API**
  - Public API for bot data
  - OAuth integration for authentication
  - Rate limiting and API keys

**Success Metrics:**
- 50+ users participate in fantasy mini-leagues
- 20% of users create tactical content
- Integration with at least 2 external news sources
- Web dashboard MVP launched (if pursued)

---

## Long-Term Vision (2026+)

### Advanced AI Features
- **AI Match Previews**: Gemini-generated match preview articles
- **Personalized Recommendations**: AI suggests players to watch based on preferences
- **Conversation Football Bot**: Natural language queries about stats and teams
- **Sentiment Analysis**: Track community mood around teams/players

### Multi-Sport Expansion
- **Basketball integration** (NBA, EuroLeague)
- **American Football** (NFL)
- **General sports framework** for easy sport addition

### Tournament Features
- **World Cup/Euros Mode**: Special features during major tournaments
- **Bracket predictions**: Full tournament prediction system
- **Group stage tracking**: Auto-updating tables and predictions

### Community Marketplace
- **User-created content store**: Buy/sell custom quizzes, formations
- **Points economy**: Earn points, spend on features
- **Premium features**: Subscription for advanced stats/features

---

## Risk Management

### Technical Risks
| Risk | Impact | Mitigation |
|------|--------|------------|
| API rate limits (football-data.org) | High | Implement Redis caching, upgrade API tier |
| Database performance with scale | Medium | Add indexing, implement read replicas |
| Discord API changes | Medium | Monitor Discord.js updates, maintain flexibility |
| AI costs (Gemini, Perspective) | Low | Set monthly budgets, optimize prompt efficiency |

### Product Risks
| Risk | Impact | Mitigation |
|------|--------|------------|
| Feature bloat | Medium | Regular feature audits, user feedback sessions |
| User fatigue with notifications | Medium | Granular notification preferences |
| Moderation accuracy | High | Human review appeals, continuous filter tuning |
| Data privacy concerns | High | Clear privacy policy, GDPR compliance, data export |

---

## Success Metrics & KPIs

### User Engagement
- **Daily Active Users (DAU)**: Target 30% increase YoY
- **Quiz Participation Rate**: Target 40% of active users
- **Watchlist Creation**: Target 50% of users
- **Retention (30-day)**: Target 60%

### Technical Performance
- **Uptime**: Target 99.5%
- **Response Time**: Target <2s for command responses
- **API Error Rate**: Target <1%

### Community Growth
- **Servers Using Bot**: Track growth and churn
- **User Satisfaction**: Quarterly surveys (target 4.5/5)
- **Feature Adoption**: Track usage of new features vs old

---

## Resource Requirements

### Development
- **Q1**: 1 developer (technical debt focus)
- **Q2-Q3**: 1-2 developers (feature development)
- **Q4**: 2 developers (complex integrations)

### Infrastructure
- **Current**: PostgreSQL database, Discord hosting
- **Q2+**: Redis instance for caching
- **Q4+**: Potential web server for dashboard

### API Costs
- **football-data.org**: Consider premium tier for more requests
- **Gemini/Perspective**: Monitor usage, set budgets
- **Q4+**: Additional API costs for news aggregation

---

## Conclusion

This roadmap balances technical improvements with user-facing features to create a best-in-class football community Discord bot. The phased approach ensures stability while continuously delivering value to users.

**Next Steps:**
1. Review and approve roadmap with stakeholders
2. Break down Q1 priorities into detailed tasks
3. Set up project tracking (GitHub Projects, Trello, etc.)
4. Begin sprint planning for Month 1

---

## Appendix: Feature Request Process

**How to submit feature requests:**
1. Create GitHub issue with label `feature-request`
2. Describe use case and expected behavior
3. Community upvote system (👍 reactions)
4. Monthly review of top requests for roadmap inclusion

**Prioritization criteria:**
- User impact (number of users affected)
- Implementation complexity
- Alignment with bot vision
- Resource availability
