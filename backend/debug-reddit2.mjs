import { fetchRedditPosts } from "./src/redditFeed.ts";
const posts = await fetchRedditPosts();
console.log("count", posts.length);
console.log(JSON.stringify(posts.slice(0, 3), null, 2));
