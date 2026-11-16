// Script build dùng chung cho mọi game. Workflow chép file này vào
// Assets/Editor/__CIBuild/ của project lúc build (không commit vào repo game).
// Không phụ thuộc package nào: Addressables được gọi qua reflection nếu project có dùng.
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;

public static class CIBuild
{
    static string Arg(string name, string fallback = null)
    {
        var args = Environment.GetCommandLineArgs();
        for (int i = 0; i < args.Length - 1; i++)
            if (args[i] == name && !args[i + 1].StartsWith("-")) return args[i + 1];
        return fallback;
    }

    static void Fail(string message)
    {
        Debug.LogError("[CIBuild] " + message);
        EditorApplication.Exit(1);
    }

    public static void BuildAndroid()
    {
        try
        {
            bool release = Arg("-ciBuildType", "debug") == "release";
            bool aab = Arg("-androidExportType", "androidPackage") == "androidAppBundle";
            string ext = aab ? ".aab" : ".apk";

            string output = Arg("-customBuildPath", "build/Android/game" + ext);
            if (!output.EndsWith(ext)) output += ext;
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output)));

            if (EditorUserBuildSettings.activeBuildTarget != BuildTarget.Android)
                EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.Android, BuildTarget.Android);
            EditorUserBuildSettings.buildAppBundle = aab;

            if (release)
            {
                string ksPass = Arg("-androidKeystorePass");
                if (string.IsNullOrEmpty(ksPass))
                {
                    Fail("Build release cần mật khẩu keystore (secret KEYSTORE_PASS_<GAME>).");
                    return;
                }
                string ksName = Arg("-androidKeystoreName");
                string alias = Arg("-androidKeyaliasName");
                string aliasPass = Arg("-androidKeyaliasPass");
                PlayerSettings.Android.useCustomKeystore = true;
                if (!string.IsNullOrEmpty(ksName)) PlayerSettings.Android.keystoreName = ksName;
                PlayerSettings.Android.keystorePass = ksPass;
                if (!string.IsNullOrEmpty(alias)) PlayerSettings.Android.keyaliasName = alias;
                PlayerSettings.Android.keyaliasPass = string.IsNullOrEmpty(aliasPass) ? ksPass : aliasPass;
            }
            else
            {
                // Debug: ký bằng key debug, không cần mật khẩu keystore của game.
                PlayerSettings.Android.useCustomKeystore = false;
            }

            if (!BuildAddressablesIfPresent()) return;

            var scenes = EditorBuildSettings.scenes.Where(s => s.enabled).Select(s => s.path).ToArray();
            if (scenes.Length == 0)
            {
                Fail("Không có scene nào được bật trong Build Settings.");
                return;
            }

            var options = new BuildPlayerOptions
            {
                scenes = scenes,
                locationPathName = output,
                target = BuildTarget.Android,
                targetGroup = BuildTargetGroup.Android,
                options = release ? BuildOptions.None : BuildOptions.Development,
            };

            Debug.Log($"[CIBuild] Build {(release ? "release" : "debug")} {ext} -> {output}, {scenes.Length} scene");
            BuildReport report = BuildPipeline.BuildPlayer(options);
            var summary = report.summary;
            Debug.Log($"[CIBuild] Kết quả: {summary.result}, {summary.totalErrors} lỗi, {summary.totalTime}, {summary.totalSize / 1048576} MB");

            if (summary.result != BuildResult.Succeeded)
            {
                Fail("Build không thành công: " + summary.result);
                return;
            }
            EditorApplication.Exit(0);
        }
        catch (Exception e)
        {
            Debug.LogException(e);
            EditorApplication.Exit(1);
        }
    }

    // Trả về false nếu Addressables build lỗi. Project không dùng Addressables thì bỏ qua.
    static bool BuildAddressablesIfPresent()
    {
        Type defaultObj = FindType("UnityEditor.AddressableAssets.AddressableAssetSettingsDefaultObject");
        Type settingsType = FindType("UnityEditor.AddressableAssets.Settings.AddressableAssetSettings");
        if (defaultObj == null || settingsType == null) return true;

        object settings = defaultObj.GetProperty("Settings", BindingFlags.Public | BindingFlags.Static)?.GetValue(null);
        if (settings == null)
        {
            Debug.Log("[CIBuild] Có package Addressables nhưng chưa có settings, bỏ qua.");
            return true;
        }

        // Tự build ở đây, nên tắt việc build lại lần nữa khi build player (chỉ trong phiên CI này).
        PropertyInfo withPlayer = settingsType.GetProperty("BuildAddressablesWithPlayerBuild");
        if (withPlayer != null)
        {
            object doNotBuild = Enum.Parse(withPlayer.PropertyType, "DoNotBuildWithPlayer");
            withPlayer.SetValue(settings, doNotBuild);
        }

        MethodInfo build = settingsType.GetMethods(BindingFlags.Public | BindingFlags.Static)
            .FirstOrDefault(m => m.Name == "BuildPlayerContent" && m.GetParameters().Length == 1
                                 && m.GetParameters()[0].IsOut);
        if (build == null)
        {
            Fail("Không tìm thấy AddressableAssetSettings.BuildPlayerContent.");
            return false;
        }

        Debug.Log("[CIBuild] Build Addressables...");
        var args = new object[] { null };
        build.Invoke(null, args);
        string error = args[0]?.GetType().GetProperty("Error")?.GetValue(args[0]) as string;
        if (!string.IsNullOrEmpty(error))
        {
            Fail("Addressables build lỗi: " + error);
            return false;
        }
        Debug.Log("[CIBuild] Addressables xong.");
        return true;
    }

    static Type FindType(string fullName) =>
        AppDomain.CurrentDomain.GetAssemblies()
            .Select(a => a.GetType(fullName, false))
            .FirstOrDefault(t => t != null);
}
