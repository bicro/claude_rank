import { betterAuth } from "better-auth";
import { getPool } from "./db";

export const auth = betterAuth({
  database: getPool(),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3001",
  trustedOrigins: [
    process.env.BETTER_AUTH_URL || "http://localhost:3001",
    "https://clauderank.com",
    "https://www.clauderank.com",
    "https://claude-rank.onrender.com",
  ],
  user: {
    changeEmail: { enabled: false },
  },
  account: {
    accountLinking: {
      enabled: true,
    },
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
      mapProfileToUser: (profile) => ({
        name: profile.name,
        image: profile.picture,
      }),
    },
    twitter: {
      clientId: process.env.TWITTER_CLIENT_ID as string,
      clientSecret: process.env.TWITTER_CLIENT_SECRET as string,
      mapProfileToUser: (profile) => ({
        name: profile.data?.name || profile.name,
        image: profile.data?.profile_image_url?.replace("_normal", "") || profile.profile_image_url || profile.image,
      }),
    },
    discord: {
      clientId: process.env.DISCORD_CLIENT_ID as string,
      clientSecret: process.env.DISCORD_CLIENT_SECRET as string,
      mapProfileToUser: (profile) => ({
        name: profile.global_name || profile.username,
        image: profile.avatar
          ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=256`
          : profile.image,
      }),
    },
    linkedin: {
      clientId: process.env.LINKEDIN_CLIENT_ID as string,
      clientSecret: process.env.LINKEDIN_CLIENT_SECRET as string,
      mapProfileToUser: (profile) => ({
        name: profile.name,
        image: profile.picture,
      }),
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID as string,
      clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
      mapProfileToUser: (profile) => ({
        name: profile.name || profile.login,
        image: profile.avatar_url,
      }),
    },
  },
});
