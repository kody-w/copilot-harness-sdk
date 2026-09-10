public class Script : ScriptBase
{
    private const string TopUrl =
        "https://hacker-news.firebaseio.com/v0/topstories.json";
    private const string ItemUrl =
        "https://hacker-news.firebaseio.com/v0/item/{0}.json";
    private const string CommentsUrl =
        "https://news.ycombinator.com/item?id={0}";

    public override async Task<HttpResponseMessage> ExecuteAsync()
    {
        if (this.Context.OperationId != "GetTopStoriesFormatted")
        {
            return await this.Context.SendAsync(
                this.Context.Request,
                this.CancellationToken
            ).ConfigureAwait(false);
        }

        int count;
        try
        {
            count = await this.ReadCountAsync().ConfigureAwait(false);
        }
        catch
        {
            return this.JsonResponse(new JObject
            {
                ["status"] = "error",
                ["message"] = "count must be an integer from 1 to 30",
            });
        }

        JArray topIds;
        try
        {
            JToken top = await this.GetJsonAsync(TopUrl).ConfigureAwait(false);
            topIds = top as JArray;
            if (topIds == null)
            {
                return this.JsonResponse(new JObject
                {
                    ["status"] = "error",
                    ["message"] = "top stories response was not a list",
                });
            }
        }
        catch (Exception error)
        {
            return this.JsonResponse(new JObject
            {
                ["status"] = "error",
                ["message"] = "fetch failed: " + error.Message,
            });
        }

        JArray stories = new JArray();
        foreach (JToken idToken in topIds.Take(count))
        {
            long storyId;
            if (!long.TryParse(idToken.ToString(), out storyId))
            {
                continue;
            }

            try
            {
                JObject item = await this.GetJsonAsync(
                    string.Format(ItemUrl, storyId)
                ).ConfigureAwait(false) as JObject;
                if (item == null)
                {
                    continue;
                }

                string fallback = string.Format(CommentsUrl, storyId);
                string externalUrl = (string)item["url"];
                stories.Add(new JObject
                {
                    ["id"] = storyId,
                    ["title"] = item["title"],
                    ["url"] = string.IsNullOrEmpty(externalUrl)
                        ? fallback
                        : externalUrl,
                    ["score"] = item["score"],
                    ["author"] = item["by"],
                    ["comments"] = item["descendants"] ?? 0,
                });
            }
            catch
            {
                // Source parity: an individual item failure is skipped.
            }
        }

        List<string> lines = new List<string>();
        for (int index = 0; index < stories.Count; index++)
        {
            JObject story = (JObject)stories[index];
            string commentsUrl = string.Format(
                CommentsUrl,
                (long)story["id"]
            );
            lines.Add(string.Format(
                "{0}. **[{1}]({2})** — {3} points, by {4} · " +
                "[{5} comments]({6})",
                index + 1,
                (string)story["title"],
                (string)story["url"],
                story["score"],
                (string)story["author"],
                story["comments"],
                commentsUrl
            ));
        }

        string summary =
            "Top Hacker News stories:\n\n" +
            string.Join("\n\n", lines) +
            "\n\nWhen presenting these to the user, render the titles as " +
            "clickable markdown links exactly as written above.";

        return this.JsonResponse(new JObject
        {
            ["status"] = "success",
            ["stories"] = stories,
            ["summary"] = summary,
            ["data_slush"] = new JObject
            {
                ["count"] = stories.Count,
                ["top_url"] = stories.Count > 0
                    ? stories[0]["url"]
                    : JValue.CreateNull(),
            },
        });
    }

    private async Task<int> ReadCountAsync()
    {
        int count = 10;
        if (this.Context.Request.RequestUri != null)
        {
            string queryValue = HttpUtility.ParseQueryString(
                this.Context.Request.RequestUri.Query
            )["count"];
            if (!string.IsNullOrWhiteSpace(queryValue))
            {
                count = Convert.ToInt32(queryValue);
                if (count == 0)
                {
                    count = 10;
                }
                return Math.Max(1, Math.Min(30, count));
            }
        }
        if (this.Context.Request.Content != null)
        {
            string body = await this.Context.Request.Content
                .ReadAsStringAsync()
                .ConfigureAwait(false);
            if (!string.IsNullOrWhiteSpace(body))
            {
                JObject parsed = JObject.Parse(body);
                JToken token = parsed["count"];
                if (token != null && token.Type != JTokenType.Null)
                {
                    count = Convert.ToInt32(token.ToString());
                    if (count == 0)
                    {
                        count = 10;
                    }
                }
            }
        }
        return Math.Max(1, Math.Min(30, count));
    }

    private async Task<JToken> GetJsonAsync(string url)
    {
        HttpRequestMessage request = new HttpRequestMessage(
            HttpMethod.Get,
            url
        );
        HttpResponseMessage response = await this.Context.SendAsync(
            request,
            this.CancellationToken
        ).ConfigureAwait(false);
        string content = await response.Content
            .ReadAsStringAsync()
            .ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                ((int)response.StatusCode).ToString() + ": " + content
            );
        }
        return JToken.Parse(content);
    }

    private HttpResponseMessage JsonResponse(JObject payload)
    {
        HttpResponseMessage response = new HttpResponseMessage(
            HttpStatusCode.OK
        );
        response.Content = CreateJsonContent(payload.ToString());
        return response;
    }
}
