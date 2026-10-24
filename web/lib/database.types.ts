export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      approvals: {
        Row: {
          args: Json
          created_at: string
          decided_at: string | null
          decided_by: string | null
          id: string
          note: string | null
          run_id: string
          status: string
          tool_call_id: string
          tool_name: string
        }
        Insert: {
          args?: Json
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          note?: string | null
          run_id: string
          status?: string
          tool_call_id: string
          tool_name: string
        }
        Update: {
          args?: Json
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          note?: string | null
          run_id?: string
          status?: string
          tool_call_id?: string
          tool_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "approvals_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_events: {
        Row: {
          action: string
          actor: string | null
          created_at: string
          detail: Json
          id: number
          organization_id: string | null
        }
        Insert: {
          action: string
          actor?: string | null
          created_at?: string
          detail?: Json
          id?: never
          organization_id?: string | null
        }
        Update: {
          action?: string
          actor?: string | null
          created_at?: string
          detail?: Json
          id?: never
          organization_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      memberships: {
        Row: {
          created_at: string
          organization_id: string
          role: string
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          organization_id: string
          role: string
          status?: string
          user_id: string
        }
        Update: {
          created_at?: string
          organization_id?: string
          role?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memberships_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_settings: {
        Row: {
          max_model_requests: number | null
          model: string | null
          monthly_cost_cap_usd: number | null
          organization_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          max_model_requests?: number | null
          model?: string | null
          monthly_cost_cap_usd?: number | null
          organization_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          max_model_requests?: number | null
          model?: string | null
          monthly_cost_cap_usd?: number | null
          organization_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
        }
        Relationships: []
      }
      provider_connections: {
        Row: {
          created_at: string
          created_by: string | null
          last4: string
          organization_id: string
          provider: string
          secret_id: string
          source: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          last4: string
          organization_id: string
          provider: string
          secret_id: string
          source?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          last4?: string
          organization_id?: string
          provider?: string
          secret_id?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_connections_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      regulation_import_files: {
        Row: {
          error: string | null
          file_name: string
          import_id: string
          position: number
          regulation_code: string
          regulation_title: string | null
          role: string | null
          sha256: string
          size_bytes: number | null
          source_url: string | null
          status: string
          updated_at: string
          url: string
          version_label: string
          version_status: string | null
          version_title: string | null
        }
        Insert: {
          error?: string | null
          file_name: string
          import_id: string
          position: number
          regulation_code: string
          regulation_title?: string | null
          role?: string | null
          sha256: string
          size_bytes?: number | null
          source_url?: string | null
          status?: string
          updated_at?: string
          url: string
          version_label: string
          version_status?: string | null
          version_title?: string | null
        }
        Update: {
          error?: string | null
          file_name?: string
          import_id?: string
          position?: number
          regulation_code?: string
          regulation_title?: string | null
          role?: string | null
          sha256?: string
          size_bytes?: number | null
          source_url?: string | null
          status?: string
          updated_at?: string
          url?: string
          version_label?: string
          version_status?: string | null
          version_title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "regulation_import_files_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "regulation_imports"
            referencedColumns: ["id"]
          },
        ]
      }
      regulation_imports: {
        Row: {
          created_at: string
          created_by: string | null
          error: string | null
          finished_at: string | null
          id: string
          index: Json
          organization_id: string
          source_name: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          index: Json
          organization_id: string
          source_name: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          index?: Json
          organization_id?: string
          source_name?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "regulation_imports_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      regulation_versions: {
        Row: {
          created_at: string
          extracted_at: string | null
          file_name: string
          id: string
          last_import_id: string | null
          md_path: string | null
          organization_id: string
          page_count: number | null
          pdf_path: string
          regulation_id: string
          role: string | null
          sha256: string
          size_bytes: number
          status: string | null
          title: string | null
          updated_at: string
          version_label: string
        }
        Insert: {
          created_at?: string
          extracted_at?: string | null
          file_name: string
          id?: string
          last_import_id?: string | null
          md_path?: string | null
          organization_id: string
          page_count?: number | null
          pdf_path: string
          regulation_id: string
          role?: string | null
          sha256: string
          size_bytes: number
          status?: string | null
          title?: string | null
          updated_at?: string
          version_label: string
        }
        Update: {
          created_at?: string
          extracted_at?: string | null
          file_name?: string
          id?: string
          last_import_id?: string | null
          md_path?: string | null
          organization_id?: string
          page_count?: number | null
          pdf_path?: string
          regulation_id?: string
          role?: string | null
          sha256?: string
          size_bytes?: number
          status?: string | null
          title?: string | null
          updated_at?: string
          version_label?: string
        }
        Relationships: [
          {
            foreignKeyName: "regulation_versions_last_import_id_fkey"
            columns: ["last_import_id"]
            isOneToOne: false
            referencedRelation: "regulation_imports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "regulation_versions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "regulation_versions_regulation_id_fkey"
            columns: ["regulation_id"]
            isOneToOne: false
            referencedRelation: "regulations"
            referencedColumns: ["id"]
          },
        ]
      }
      regulations: {
        Row: {
          code: string
          created_at: string
          id: string
          kind: string
          organization_id: string
          slug: string
          source_url: string | null
          title: string | null
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          id?: string
          kind: string
          organization_id: string
          slug: string
          source_url?: string | null
          title?: string | null
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          id?: string
          kind?: string
          organization_id?: string
          slug?: string
          source_url?: string | null
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "regulations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      run_events: {
        Row: {
          created_at: string
          id: number
          kind: string
          payload: Json
          run_id: string
        }
        Insert: {
          created_at?: string
          id?: never
          kind: string
          payload?: Json
          run_id: string
        }
        Update: {
          created_at?: string
          id?: never
          kind?: string
          payload?: Json
          run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_events_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      run_files: {
        Row: {
          bytes: number
          created_at: string
          filename: string
          format: string
          id: string
          media_type: string | null
          organization_id: string
          run_id: string
          sha256: string | null
          storage_path: string
        }
        Insert: {
          bytes: number
          created_at?: string
          filename: string
          format: string
          id?: string
          media_type?: string | null
          organization_id: string
          run_id: string
          sha256?: string | null
          storage_path: string
        }
        Update: {
          bytes?: number
          created_at?: string
          filename?: string
          format?: string
          id?: string
          media_type?: string | null
          organization_id?: string
          run_id?: string
          sha256?: string | null
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_files_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "run_files_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      run_state: {
        Row: {
          conversation: Json
          run_id: string
          updated_at: string
        }
        Insert: {
          conversation: Json
          run_id: string
          updated_at?: string
        }
        Update: {
          conversation?: Json
          run_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_state_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      runs: {
        Row: {
          created_at: string
          created_by: string
          error: string | null
          id: string
          model: string | null
          organization_id: string
          output: string | null
          status: string
          task: string
          updated_at: string
          usage: Json
        }
        Insert: {
          created_at?: string
          created_by?: string
          error?: string | null
          id?: string
          model?: string | null
          organization_id: string
          output?: string | null
          status?: string
          task: string
          updated_at?: string
          usage?: Json
        }
        Update: {
          created_at?: string
          created_by?: string
          error?: string | null
          id?: string
          model?: string | null
          organization_id?: string
          output?: string | null
          status?: string
          task?: string
          updated_at?: string
          usage?: Json
        }
        Relationships: [
          {
            foreignKeyName: "runs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      bootstrap_member: {
        Args: {
          make_platform_admin: boolean
          member: string
          member_role: string
        }
        Returns: string
      }
      can_reset_password: { Args: { member: string }; Returns: boolean }
      cancel_regulation_import: { Args: { job: string }; Returns: undefined }
      create_organization: { Args: { org_name: string }; Returns: string }
      create_regulation_import: {
        Args: { org: string; regulation_index: Json; source_name: string }
        Returns: string
      }
      delete_provider_key: {
        Args: { key_provider: string; org: string }
        Returns: undefined
      }
      my_access: { Args: never; Returns: Json }
      organization_people: {
        Args: { org: string }
        Returns: {
          email: string
          last_sign_in_at: string
          role: string
          status: string
          user_id: string
        }[]
      }
      organization_usage: {
        Args: { months?: number; org: string }
        Returns: {
          cost_usd: number
          month: string
          runs: number
          tokens: number
        }[]
      }
      read_provider_key: {
        Args: { key_provider: string; org: string }
        Returns: string
      }
      record_deployment_change: {
        Args: { change: string; detail: Json }
        Returns: undefined
      }
      record_regulation_version: {
        Args: {
          p_code: string
          p_file_name: string
          p_import_id: string
          p_kind: string
          p_organization_id: string
          p_pdf_path: string
          p_role: string
          p_sha256: string
          p_size_bytes: number
          p_slug: string
          p_source_url: string
          p_status: string
          p_title: string
          p_version_label: string
          p_version_title: string
        }
        Returns: string
      }
      set_member: {
        Args: {
          member: string
          member_role: string
          member_status?: string
          org: string
        }
        Returns: undefined
      }
      set_provider_key: {
        Args: {
          api_key: string
          key_provider: string
          key_source?: string
          org: string
        }
        Returns: undefined
      }
      start_run: {
        Args: { p_files?: Json; p_organization_id: string; p_task: string }
        Returns: string
      }
      update_organization_settings: {
        Args: {
          new_max_model_requests: number
          new_model: string
          new_monthly_cost_cap_usd: number
          org: string
        }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
